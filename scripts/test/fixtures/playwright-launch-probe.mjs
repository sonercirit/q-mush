import { registerHooks } from "node:module";

const PLAYWRIGHT_ENTRY = "/node_modules/playwright/index.mjs";
const PLAYWRIGHT_IMPORT = "import playwright from 'playwright-core';";
const PROBE = `
const playwrightCore = await import("playwright-core/lib/coreBundle");
playwright.chromium.launch = (options = {}) => {
  const serverPlaywright = playwrightCore.server.createPlaywright({
    sdkLanguage: "javascript",
  });
  const browserType = serverPlaywright.chromium;
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(browserType));
  const effective = prototype._validateLaunchOptions.call(browserType, options);
  console.log(
    "PLAYWRIGHT_LAUNCH_PROBE=" +
      JSON.stringify({
        configuredHeadless: options.headless,
        effectiveHeadless: effective.headless,
        playwrightDebug: process.env.PWDEBUG,
      }),
  );
  return Promise.reject(new Error("Browser launch captured by policy probe"));
};
`;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith(PLAYWRIGHT_ENTRY)) return result;
    const source = result.source?.toString();
    if (source === undefined || !source.includes(PLAYWRIGHT_IMPORT)) {
      throw new Error("Could not instrument the Playwright entrypoint");
    }
    return {
      ...result,
      source: source.replace(PLAYWRIGHT_IMPORT, PLAYWRIGHT_IMPORT + PROBE),
    };
  },
});
