import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid({ dev: false, hot: false }), tailwindcss()],
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
      viewport: { height: 720, width: 1_024 },
    },
    environment: "node",
    include: ["solid/test/**/*.browser.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
});
