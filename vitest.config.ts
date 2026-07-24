import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const TEST_FILE_EXTENSIONS = "{cjs,cts,js,jsx,mjs,mts,ts,tsx}";
const TEST_INCLUDE = [`**/test/**/*.{spec,test}.${TEST_FILE_EXTENSIONS}`];
const DOM_TEST_INCLUDE = [
  `**/test/**/*.dom.{spec,test}.${TEST_FILE_EXTENSIONS}`,
];
const NON_SOURCE_TEST_EXCLUDE = [
  "**/.git/**",
  "**/node_modules/**",
  "coverage/**",
  "data/**",
  "dist/**",
  "out/**",
];

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        plugins: [solid({ ssr: true })],
        test: {
          allowOnly: false,
          environment: "node",
          exclude: [...NON_SOURCE_TEST_EXCLUDE, ...DOM_TEST_INCLUDE],
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
          allowOnly: false,
          environment: "happy-dom",
          exclude: NON_SOURCE_TEST_EXCLUDE,
          include: DOM_TEST_INCLUDE,
          name: "dom",
          server: { deps: { inline: [/solid-js/u] } },
          testTimeout: 15_000,
        },
      },
    ],
  },
});
