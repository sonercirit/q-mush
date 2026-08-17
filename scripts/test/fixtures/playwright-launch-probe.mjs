import process from "node:process";
import { chromium } from "playwright";

const REQUIRED_NODE_VERSION = "24.15.0";
const EXPECTED_FAILURE =
  "Playwright launch probe executable unexpectedly started";
const LAUNCH_PATTERN = /<launching> ([^\n]+)/u;

if (process.versions.node !== REQUIRED_NODE_VERSION) {
  process.stderr.write(
    `Playwright launch probe requires Node ${REQUIRED_NODE_VERSION}; found ${process.versions.node}. Use the CI-pinned Node version.\n`,
  );
  process.exitCode = 2;
} else {
  const options = { executablePath: process.execPath, headless: true };

  try {
    const browserServer = await chromium.launchServer(options);
    await browserServer.close();
    throw new Error(EXPECTED_FAILURE);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new TypeError(
        "Playwright launch probe received a non-Error failure",
        { cause: error },
      );
    }
    const launchCommand = LAUNCH_PATTERN.exec(error.message)?.[1];
    if (launchCommand === undefined) {
      process.stderr.write(
        `Playwright launch probe could not inspect launch arguments: ${error.message}\n`,
      );
      process.exitCode = 2;
    } else {
      process.stdout.write(
        `PLAYWRIGHT_LAUNCH_PROBE=${JSON.stringify({
          configuredHeadless: options.headless,
          effectiveHeadless: launchCommand.includes(" --headless "),
          playwrightDebug: process.env.PWDEBUG,
        })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
