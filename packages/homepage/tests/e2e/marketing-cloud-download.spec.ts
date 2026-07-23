/**
 * Playwright coverage for the homepage cloud CTA and the /downloads surface.
 *
 * Platform release binaries are stale, so the site intentionally exposes only
 * two paths: Eliza Cloud (primary) and the GitHub repo (secondary). These
 * tests pin that contract.
 */

import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import {
  type APIRequestContext,
  expect,
  type Locator,
  test,
} from "playwright/test";

async function expectCloudPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href ?? "", EXTERNAL_URLS.cloud);
  expect(url.origin).toBe(EXTERNAL_URLS.cloud);
  expect(url.pathname).toMatch(/^\/?$/);
}

async function expectReachableHead(
  request: APIRequestContext,
  label: string,
  href: string,
) {
  const response = await request.fetch(href, {
    method: "HEAD",
    maxRedirects: 5,
    timeout: 20_000,
  });
  expect(
    response.status(),
    `${label} should resolve without a broken third-party target: ${href}`,
  ).toBeLessThan(400);
}

test("homepage leads with Eliza Cloud and the GitHub repo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle("Eliza — your agent, everywhere");

  // Deck hero copy (desktop overlay on the animated page).
  await expect(
    page.getByRole("heading", {
      name: /There’s nothing wrong with you\. You’re just overwhelmed\./,
    }),
  ).toBeVisible({ timeout: 15_000 });

  // Primary CTA: plain same-tab anchor straight to the cloud origin. Two
  // instances exist on desktop (header pill + hero button); both must point
  // at the cloud root with no login interstitial.
  const cloudCtas = page.getByRole("link", { name: /^Open Eliza Cloud/ });
  const ctaCount = await cloudCtas.count();
  expect(ctaCount).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < ctaCount; i++) {
    const cta = cloudCtas.nth(i);
    await expectCloudPath(cta);
    await expect(cta).not.toHaveAttribute("target", /.+/);
  }

  // Secondary: the open-source repo link.
  await expect(
    page.getByRole("link", { name: /Open source on GitHub/i }),
  ).toHaveAttribute("href", EXTERNAL_URLS.github);

  // No download grid anywhere on the primary path.
  await expect(page.locator(".app-download-grid")).toHaveCount(0);

  // No horizontal overflow.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
});

test("/downloads is a cloud-first page without stale release cards", async ({
  page,
}) => {
  await page.goto("/downloads", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("heading", { name: /^Start in the cloud\.$/ }),
  ).toBeVisible({ timeout: 10_000 });

  const cloudCta = page.getByRole("link", { name: /^Open Eliza Cloud/ });
  await expectCloudPath(cloudCta.first());

  await expect(
    page.getByRole("link", { name: /Open source on GitHub/i }),
  ).toHaveAttribute("href", EXTERNAL_URLS.github);

  // The stale release-download grid must not come back.
  await expect(page.locator(".app-download-grid")).toHaveCount(0);
  await expect(page.locator("[data-testid=os-artifact-grid]")).toHaveCount(0);

  // Install scripts stay reachable (footer), never promoted above the fold.
  await expect(
    page.getByRole("link", { name: /^install\.sh$/ }),
  ).toHaveAttribute("href", "/install.sh");
  await expect(
    page.getByRole("link", { name: /^install\.ps1$/ }),
  ).toHaveAttribute("href", "/install.ps1");
});

test("live links on / and /downloads resolve", async ({ page, request }) => {
  const seen = new Map<string, string>();
  for (const path of ["/", "/downloads"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
      anchors
        .map((anchor) => ({
          label: anchor.textContent?.replace(/\s+/g, " ").trim() || "link",
          href: anchor.getAttribute("href"),
        }))
        .filter(
          (link): link is { label: string; href: string } =>
            Boolean(link.href) && !link.href.startsWith("#"),
        ),
    );
    for (const link of hrefs) {
      const url = new URL(link.href, page.url());
      if (url.origin === new URL(page.url()).origin) continue;
      if (url.protocol !== "https:") continue;
      seen.set(url.toString(), link.label);
    }
  }

  // Every third-party link must be cloud or github, nothing else on the
  // promoted paths.
  for (const href of seen.keys()) {
    const { origin } = new URL(href);
    expect(
      [EXTERNAL_URLS.cloud, "https://github.com"].some((allowed) =>
        origin.startsWith(allowed),
      ),
      `unexpected third-party origin on promoted path: ${href}`,
    ).toBe(true);
  }

  for (const [href, label] of seen) {
    await expectReachableHead(request, label, href);
  }
});
