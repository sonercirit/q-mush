import knipConfig from "./knip.config.ts";

/** @public Loaded by the Knip CLI through `--config`. */
export default {
  ...knipConfig,
  entry: [
    "src/index.ts!",
    "src/client.tsx!",
    "src/runner-agent.ts!",
    "src/styles.css!",
    "scripts/dev.ts!",
    "scripts/migrate-database.ts!",
    "scripts/repository-check.ts!",
    "scripts/restart-development-server.ts!",
  ],
  project: [
    "src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "!**/test/**!",
  ],
};
