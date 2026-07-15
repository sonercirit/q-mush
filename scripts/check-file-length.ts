import { join } from "node:path";

const CHARACTER_LIMIT = 20_000;
const EXCLUDED_PATH = "bun.lock";

interface FileLengthViolation {
  readonly characterCount: number;
  readonly path: string;
}

const countCharacters = (contents: string): number => Array.from(contents).length;

export async function findFileLengthViolations(
  rootDirectory: string,
  paths: readonly string[],
): Promise<FileLengthViolation[]> {
  const violations: FileLengthViolation[] = [];

  for (const path of paths) {
    if (path === EXCLUDED_PATH) {
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

async function listProjectFiles(rootDirectory: string): Promise<string[]> {
  const git = Bun.spawn(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      cwd: rootDirectory,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
    git.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      detail === ""
        ? "Could not list project files with git."
        : `Could not list project files with git: ${detail}`,
    );
  }

  return stdout.split("\0").filter((path) => path !== "");
}

async function run(): Promise<void> {
  const rootDirectory = join(import.meta.dir, "..");
  const paths = await listProjectFiles(rootDirectory);
  const violations = await findFileLengthViolations(rootDirectory, paths);

  if (violations.length > 0) {
    console.error(formatFileLengthViolations(violations));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await run();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
