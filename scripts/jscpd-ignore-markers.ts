import { extname, join } from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".es",
  ".es6",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const JSCPD_IGNORE_MARKER_PATTERN = /:?jscpd:ignore-(?:start|end)/iu;

interface JscpdIgnoreMarker {
  readonly line: number;
  readonly path: string;
}

export async function findJscpdIgnoreMarkers(
  rootDirectory: string,
  paths: readonly string[],
): Promise<JscpdIgnoreMarker[]> {
  const violationGroups = await Promise.all(
    paths.map(async (path): Promise<JscpdIgnoreMarker[]> => {
      if (!SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
        return [];
      }

      const filePath = join(rootDirectory, path);

      if (!(await Bun.file(filePath).exists())) {
        return [];
      }

      return (await Bun.file(filePath).text())
        .split("\n")
        .flatMap((line, lineIndex) =>
          JSCPD_IGNORE_MARKER_PATTERN.test(line)
            ? [{ line: lineIndex + 1, path }]
            : [],
        );
    }),
  );

  return violationGroups.flat();
}

export function formatJscpdIgnoreMarkers(
  violations: readonly JscpdIgnoreMarker[],
): string {
  return [
    "jscpd ignore markers are forbidden in source files:",
    ...violations.map(({ line, path }) => `- ${path}:${String(line)}`),
    "Remove every marker and de-duplicate the code instead.",
  ].join("\n");
}
