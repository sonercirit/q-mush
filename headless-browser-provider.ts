import type { BrowserProvider, BrowserProviderOption } from "vitest/node";

function forceHeadless(
  project: Parameters<BrowserProviderOption["providerFactory"]>[0],
): void {
  // Vitest applies CLI and project overrides after loading the config.
  project.config.browser.headless = true;
  for (const instance of project.config.browser.instances ?? []) {
    instance.headless = true;
  }
}

export function enforceHeadlessBrowser(
  provider: BrowserProviderOption,
): BrowserProviderOption {
  return {
    ...provider,
    providerFactory: (project): BrowserProvider => {
      forceHeadless(project);
      const browser = provider.providerFactory(project);
      const openPage = browser.openPage.bind(browser);
      browser.openPage = (sessionId, url, options) => {
        forceHeadless(project);
        return openPage(sessionId, url, options);
      };
      return browser;
    },
  };
}
