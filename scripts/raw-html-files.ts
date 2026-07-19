const RAW_HTML_FILE_PATTERN = /\.(?:html?|xhtml)$/iu;
const ALLOWED_DIRECTORY_NAMES = new Set(["fixtures", "test"]);

export function findRawHtmlFileViolations(paths: readonly string[]): string[] {
  const violations: string[] = [];

  for (const path of paths) {
    if (!RAW_HTML_FILE_PATTERN.test(path)) {
      continue;
    }

    const directories = path.split("/");
    directories.pop();

    if (
      !directories.some((directory) => ALLOWED_DIRECTORY_NAMES.has(directory))
    ) {
      violations.push(path);
    }
  }

  return violations;
}

export function formatRawHtmlFileViolations(paths: readonly string[]): string {
  const details = paths.map((path) => `- ${path}`).join("\n");

  return `Raw HTML files are only allowed as test fixtures:\n${details}\nMigrate application markup to TSX instead.`;
}
