/**
 * Guards the mobile bundle against reintroducing write-only globalThis plugin
 * pins: asserts bin.ts and android-app-plugins.ts keep their plugin modules alive
 * through consumed side effects (the STATIC_ELIZA_PLUGINS Object.assign and
 * bin.ts's literal-specifier anchor imports) rather than dead pinning globals.
 * Deterministic source-text scan — reads the two files as strings, no bundling.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = path.resolve(here, "..");

function read(rel: string): string {
  return readFileSync(path.join(agentSrc, rel), "utf8");
}

/**
 * Write-only globalThis keys that pin plugin functions purely to defeat Bun
 * tree-shaking are forbidden — nothing reads them (#12091 item 29). Modules stay
 * in the bundle via consumed side effects (the STATIC_ELIZA_PLUGINS Object.assign
 * and the literal-specifier anchor imports), so no such pin is needed. This list
 * guards against reintroducing the dead pins.
 */
const DEAD_GLOBALS = [
  "__eliza" + "AospLlamaLoader",
  "__eliza" + "AospLocalInferenceBootstrap",
  "__eliza" + "MobileDeviceBridgeBootstrap",
  "__eliza" + "AndroidAppPlugins",
] as const;

describe("mobile bundle anchors (no write-only globalThis pinning)", () => {
  const binSource = read("bin.ts");
  const androidSource = read("runtime/android-app-plugins.ts");
  const mobileBuildScript = readFileSync(
    path.resolve(agentSrc, "..", "scripts", "build-mobile-bundle.mjs"),
    "utf8",
  );

  it("removes every write-only plugin-pinning global", () => {
    const haystack = `${binSource}\n${androidSource}`;
    for (const name of DEAD_GLOBALS) {
      expect(haystack, name).not.toContain(name);
    }
  });

  it("keeps the STATIC_ELIZA_PLUGINS registry side effect that anchors the app plugins", () => {
    expect(androidSource).toContain("Object.assign(STATIC_ELIZA_PLUGINS");
  });

  it("keeps bin.ts literal-specifier anchor imports for the pinned packages", () => {
    expect(binSource).toContain(
      'import(/* @vite-ignore */ "@elizaos/plugin-aosp-local-inference")',
    );
    expect(binSource).toContain(
      '"@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"',
    );
  });

  it("does not null-stub the AOSP local-inference bootstrap package", () => {
    expect(mobileBuildScript).not.toMatch(
      /"@elizaos\/plugin-aosp-local-inference"\s*:\s*path\.join\(\s*stubsDir\s*,\s*"null-plugin\.cjs"\s*\)/,
    );
  });

  it("keeps auth routes eagerly imported and build-guarded in the mobile bundle", () => {
    const serverSource = read("api/server.ts");
    expect(serverSource).toContain(
      'import { handleAuthRoutes } from "./auth-routes.ts";',
    );
    expect(serverSource).not.toMatch(
      /handleAuthRoutes,\n[\s\S]*from "\.\/server-lazy-routes\.ts"/,
    );
    expect(mobileBuildScript).toContain('"/api/auth/me"');
    expect(mobileBuildScript).toContain('"/api/auth/status"');
    expect(mobileBuildScript).toContain(
      "mobile bundle is missing required auth route marker",
    );
  });

  it("repairs only the known dead malformed Bun re-export after named exports exist", () => {
    expect(mobileBuildScript).toContain("repairMalformedDeadReExport");
    expect(mobileBuildScript).toContain("__toESM\\(\\s*,\\s*1\\s*\\)");
    expect(mobileBuildScript).toMatch(
      /refusing to repair \$\{matches\.length\} malformed __toESM\(, 1\) statements/,
    );
    expect(mobileBuildScript).toContain(
      "named exports were not already emitted",
    );
    expect(mobileBuildScript).not.toContain("new Function(bundleSrc)");
    expect(mobileBuildScript).not.toContain("catch (err) {");
  });
});
