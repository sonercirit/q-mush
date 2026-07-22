import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const TEST_INCLUDE = ["**/test/**/*.test.{ts,tsx}"];
const DOM_TEST_INCLUDE = ["**/test/**/*.dom.test.{ts,tsx}"];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [solid({ ssr: true })],
        test: {
          environment: "node",
          exclude: DOM_TEST_INCLUDE,
          include: TEST_INCLUDE,
          name: "server",
          testTimeout: 15_000,
        },
      },
      {
        plugins: [solid({ dev: false, hot: false })],
        resolve: {
          alias: [
            {
              find: /^solid-js$/u,
              replacement: new URL(
                "./node_modules/solid-js/dist/solid.js",
                import.meta.url,
              ).pathname,
            },
          ],
        },
        test: {
          environment: "happy-dom",
          include: DOM_TEST_INCLUDE,
          name: "dom",
          server: { deps: { inline: [/solid-js/u] } },
          testTimeout: 15_000,
        },
      },
    ],
  },
});
