import { chromium } from "playwright";

// Playwright 1.62.1's public launch failure currently reports the spawned
// command as `<launching> ...`. Keep this fail-closed probe and its pinned-version
// assertion in browser-test-policy.test.ts green before upgrading Playwright.
const EXPECTED_FAILURE =
  "Playwright launch probe executable unexpectedly started";
const LAUNCH_PATTERN = /<launching> ([^\n]+)/u;
const options = { executablePath: process.execPath, headless: true };

try {
  const browserServer = await chromium.launchServer(options);
  await browserServer.close();
  throw new Error(EXPECTED_FAILURE);
} catch (error) {
  if (!(error instanceof Error)) {
    throw new TypeError(
      "Playwright launch probe received a non-Error failure",
      {
        cause: error,
      },
    );
  }
  const launchCommand = LAUNCH_PATTERN.exec(error.message)?.[1];
  if (launchCommand === undefined) {
    process.stderr.write(
      `Playwright launch probe could not inspect Playwright 1.62.1 launch arguments; update the compatibility probe before changing Playwright: ${error.message}\n`,
    );
    process.exitCode = 2;
  } else {
    process.stdout.write(
      `PLAYWRIGHT_LAUNCH_PROBE=${JSON.stringify({
        configuredHeadless: options.headless,
        effectiveHeadless: launchCommand.includes(" --headless "),
        playwrightDebug: process.env["PWDEBUG"],
        workingDirectory: process.cwd(),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
