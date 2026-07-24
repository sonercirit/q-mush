/** @public Loaded by the Knip CLI through `--config`. */
export default {
  entry: [
    "sync-engine/index.ts!",
    "solid/client.tsx!",
    "runner/runner-agent.ts!",
    "solid/favicon.svg!",
    "solid/styles.css!",
    "scripts/dev.ts!",
    "scripts/migrate-database.ts!",
    "scripts/repository-check.ts!",
    "scripts/restart-development-server.ts!",
  ],
  ignoreFiles: ["knip.config.ts"],
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
