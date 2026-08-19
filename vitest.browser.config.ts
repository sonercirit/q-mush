import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { enforceHeadlessBrowser } from "./headless-browser-provider.ts";

const BROWSER_LAUNCH_REPORT = "Q_MUSH_BROWSER_LAUNCH_REPORT";
const launchProbePath = process.env[BROWSER_LAUNCH_REPORT];
const provider = enforceHeadlessBrowser(playwright(), launchProbePath);

export default defineConfig({
  plugins: [solid({ dev: false, hot: false }), tailwindcss()],
  test: {
    allowOnly: false,
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium", headless: true }],
      provider,
      viewport: { height: 720, width: 1_024 },
    },
    environment: "node",
    include: ["solid/test/**/*.browser.test.{ts,tsx}"],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
