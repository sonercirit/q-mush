import knipConfig from "./knip.config.ts";

/** @public Loaded by the Knip CLI through `--config`. */
export default {
  ...knipConfig,
  entry: ["src/index.ts!", "scripts/repository-check.ts!"],
  project: [
    "src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "!**/test/**!",
  ],
};
