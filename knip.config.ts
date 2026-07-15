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

export default {
  entry: ["knip.production.config.ts"],
  include: includedIssueTypes,
  includeEntryExports: true,
  rules: createErrorRules(includedIssueTypes),
};
