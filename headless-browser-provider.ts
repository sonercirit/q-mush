import { writeFile } from "node:fs/promises";
import type { BrowserProvider, BrowserProviderOption } from "vitest/node";

interface HeadlessProviderOptions {
  readonly provider: BrowserProviderOption;
}

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
  launchReportPath?: string,
): BrowserProviderOption<HeadlessProviderOptions> {
  return {
    ...provider,
    options: { provider },
    providerFactory: (project): BrowserProvider => {
      forceHeadless(project);
      if (launchReportPath !== undefined) {
        return {
          close: () => undefined,
          getCommandsContext: () => ({}),
          name: "playwright",
          openPage: () =>
            writeFile(
              launchReportPath,
              JSON.stringify({ headless: project.config.browser.headless }),
            ).then(() => Promise.reject(new Error("Browser launch captured"))),
          supportsParallelism: true,
        };
      }
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
