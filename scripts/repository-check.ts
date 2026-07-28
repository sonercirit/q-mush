import { join } from "node:path";
import {
  findFileLengthViolations,
  formatFileLengthViolations,
} from "./check-file-length.ts";
import {
  findJscpdIgnoreMarkers,
  formatJscpdIgnoreMarkers,
} from "./jscpd-ignore-markers.ts";
import {
  findRawHtmlFileViolations,
  formatRawHtmlFileViolations,
} from "./raw-html-files.ts";
import {
  findTestLocationViolations,
  formatTestLocationViolations,
} from "./test-location.ts";

async function listProjectFiles(rootDirectory: string): Promise<string[]> {
  const git = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
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

  const paths = stdout.split("\0").filter((path) => path !== "");
  const existingPaths: string[] = [];

  for (const path of paths) {
    if (await Bun.file(join(rootDirectory, path)).exists()) {
      existingPaths.push(path);
    }
  }

  return existingPaths;
}

async function run(): Promise<void> {
  const rootDirectory = join(import.meta.dir, "..");
  const paths = await listProjectFiles(rootDirectory);
  const fileLengthViolations = await findFileLengthViolations(
    rootDirectory,
    paths,
  );
  const jscpdIgnoreMarkers = await findJscpdIgnoreMarkers(rootDirectory, paths);
  const rawHtmlFileViolations = findRawHtmlFileViolations(paths);
  const testLocationViolations = findTestLocationViolations(paths);
  const messages: string[] = [];

  if (fileLengthViolations.length > 0) {
    messages.push(formatFileLengthViolations(fileLengthViolations));
  }

  if (jscpdIgnoreMarkers.length > 0) {
    messages.push(formatJscpdIgnoreMarkers(jscpdIgnoreMarkers));
  }

  if (rawHtmlFileViolations.length > 0) {
    messages.push(formatRawHtmlFileViolations(rawHtmlFileViolations));
  }

  if (testLocationViolations.length > 0) {
    messages.push(formatTestLocationViolations(testLocationViolations));
  }

  if (messages.length > 0) {
    console.error(messages.join("\n\n"));
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
