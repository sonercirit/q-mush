import { join } from "node:path";

const CHARACTER_LIMIT = 20_000;
const EXCLUDED_PATH = "bun.lock";
const MIGRATIONS_PATH_PREFIX = "drizzle/";

interface FileLengthViolation {
  readonly characterCount: number;
  readonly path: string;
}

const countCharacters = (contents: string): number =>
  Array.from(contents).length;

export async function findFileLengthViolations(
  rootDirectory: string,
  paths: readonly string[],
): Promise<FileLengthViolation[]> {
  const violations: FileLengthViolation[] = [];

  for (const path of paths) {
    if (path === EXCLUDED_PATH || path.startsWith(MIGRATIONS_PATH_PREFIX)) {
      continue;
    }

    const file = Bun.file(join(rootDirectory, path));

    if (!(await file.exists())) {
      continue;
    }

    const characterCount = countCharacters(await file.text());

    if (characterCount >= CHARACTER_LIMIT) {
      violations.push({ characterCount, path });
    }
  }

  return violations;
}

export function formatFileLengthViolations(
  violations: readonly FileLengthViolation[],
): string {
  const details = violations.map(
    ({ characterCount, path }) =>
      `- ${path}: ${characterCount.toLocaleString("en-US")} characters`,
  );

  return [
    `Files must stay below ${CHARACTER_LIMIT.toLocaleString("en-US")} characters:`,
    ...details,
    "Split or condense each listed file to keep it below the limit.",
  ].join("\n");
}
