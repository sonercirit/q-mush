const TEST_FILE_PATTERN = /(?:^|[._-])(?:spec|test)(?:-d)?\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY = "test";

export function findTestLocationViolations(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const segments = path.split("/");
    const fileName = segments.pop();

    return (
      fileName !== undefined &&
      TEST_FILE_PATTERN.test(fileName) &&
      !segments.includes(TEST_DIRECTORY)
    );
  });
}

export function formatTestLocationViolations(paths: readonly string[]): string {
  return [
    `Test files must be inside a directory named "${TEST_DIRECTORY}":`,
    ...paths.map((path) => `- ${path}`),
    "Move each listed test under a test directory at any depth.",
  ].join("\n");
}
