const includedIssueTypes = [
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "exports",
  "nsExports",
  "types",
  "nsTypes",
  "enumMembers",
  "namespaceMembers",
  "duplicates",
  "catalog",
  "cycles",
] as const;

type IncludedIssueType = (typeof includedIssueTypes)[number];

function createErrorRules(
  issueTypes: readonly IncludedIssueType[],
): Partial<Record<IncludedIssueType, "error">> {
  const rules: Partial<Record<IncludedIssueType, "error">> = {};

  for (const issueType of issueTypes) {
    rules[issueType] = "error";
  }

  return rules;
}

const knipConfig = {
  entry: [
    "knip.production.config.ts",
    "vitest.browser.config.ts",
    "**/test/**/*.test.{ts,tsx}!",
    "scripts/test/fixtures/*.{ts,tsx}!",
  ],
  include: includedIssueTypes,
  ignoreIssues: { "vitest.browser.config.ts": ["exports"] },
  includeEntryExports: true,
  ignoreDependencies: ["tailwindcss"],
  project: [
    "runner/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "shared/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "solid/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "sync-engine/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}!",
    "*.{cts,mts,ts}!",
  ],
  rules: createErrorRules(includedIssueTypes),
};

export default knipConfig;
