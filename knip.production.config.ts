/** @public Loaded by the Knip CLI through `--config`. */
export default {
  entry: [
    "sync-engine/index.ts!",
    "solid/client.tsx!",
    "runner/runner-agent.ts!",
    "solid/favicon.svg!",
    "solid/styles.css!",
    "scripts/cpd.ts!",
    "scripts/dev.ts!",
    "scripts/migrate-database.ts!",
    "scripts/repository-check.ts!",
    "scripts/restart-development-server.ts!",
    "scripts/test-browser.ts!",
    "shared/operation-checkpoint.ts!",
    "shared/operation-core.ts!",
    "sync-engine/operation-intake.ts!",
    "sync-engine/operation-store.ts!",
  ],
  ignoreFiles: [
    "knip.config.ts",
    "headless-browser-provider.ts",
    "vitest.browser.config.ts",
  ],
  project: [
    "runner/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "shared/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "solid/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "sync-engine/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "*.{cts,mts,ts}!",
    "!**/test/**!",
  ],
};
