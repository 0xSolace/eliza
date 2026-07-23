/**
 * Secondary "get Eliza" surface at /downloads.
 *
 * Platform release binaries are stale, so this page deliberately does NOT
 * surface a download grid. The two supported paths right now:
 *   1. Eliza Cloud (primary, unmissable)
 *   2. The open-source GitHub repo (secondary)
 * Install scripts stay reachable at /install.sh + /install.ps1 for people who
 * know what they're doing, listed quietly at the bottom, never promoted.
 */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { ArrowRight } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

/** GitHub mark (lucide dropped brand icons; vendored inline). */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.4.6.1.82-.26.82-.58v-2.03c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.9 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const cloudUrl = EXTERNAL_URLS.cloud;
const githubUrl = EXTERNAL_URLS.github;

export default function MarketingPage() {
  const t = useT();

  return (
    <div className="theme-app app-shell">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[var(--brand-orange)]"
      >
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="app-header">
        <a
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="app-brand"
        >
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            draggable={false}
            className="app-brand-mark"
          />
        </a>
        <nav
          className="app-nav"
          aria-label={t("homepage_eliza.marketing.navProducts", {
            defaultValue: "Eliza products",
          })}
        >
          <a href={cloudUrl}>
            {t("homepage_eliza.marketing.navCloud", { defaultValue: "Cloud" })}
          </a>
          <a href={githubUrl}>
            {t("homepage_eliza.marketing.navGithub", {
              defaultValue: "GitHub",
            })}
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="brand-section brand-section--cloud app-hero">
          <div className="app-cloud-scrim" />
          <div className="app-band-inner app-hero-grid app-hero-copy--cloud">
            <div className="app-hero-copy">
              <p className="app-kicker">
                {t("homepage_eliza.marketing.heroKicker", {
                  defaultValue: "Eliza",
                })}
              </p>
              <h1 className="app-display">
                {t("homepage_eliza.marketing.heroCloudFirst", {
                  defaultValue: "Start in the cloud.",
                })}
              </h1>
              <p className="app-lede">
                {t("homepage_eliza.marketing.heroCloudLede", {
                  defaultValue:
                    "Eliza Cloud is the fastest way to get your Eliza running. No installs, no setup.",
                })}
              </p>
              <div className="app-cta-row">
                <a href={cloudUrl} className="app-cta app-cta--black">
                  {t("homepage_eliza.marketing.ctaOpenCloud", {
                    defaultValue: "Open Eliza Cloud",
                  })}
                  <ArrowRight className="app-icon" aria-hidden="true" />
                </a>
                <a href={githubUrl} className="app-cta app-cta--glass">
                  <GithubIcon className="app-icon" />
                  {t("homepage_eliza.marketing.ctaGithub", {
                    defaultValue: "Open source on GitHub",
                  })}
                </a>
              </div>
              <p className="app-install-note">
                {t("homepage_eliza.marketing.selfHostNote", {
                  defaultValue:
                    "Self-hosting? Everything you need lives in the repo:",
                })}{" "}
                <a href={githubUrl}>github.com/elizaOS/eliza</a>
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaWhite}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            className="app-footer-logo"
            draggable={false}
          />
          <nav
            className="app-footer-nav"
            aria-label={t("homepage_eliza.marketing.footerNavAria", {
              defaultValue: "Footer",
            })}
          >
            <a href={cloudUrl}>
              {t("homepage_eliza.marketing.footerCloud", {
                defaultValue: "Eliza Cloud",
              })}
            </a>
            <a href={githubUrl}>
              {t("homepage_eliza.marketing.footerGithub", {
                defaultValue: "GitHub",
              })}
            </a>
            <a href="/install.sh">
              {t("homepage_eliza.marketing.footerInstallSh", {
                defaultValue: "install.sh",
              })}
            </a>
            <a href="/install.ps1">
              {t("homepage_eliza.marketing.footerInstallPs1", {
                defaultValue: "install.ps1",
              })}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
