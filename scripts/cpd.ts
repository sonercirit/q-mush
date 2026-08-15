import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findNamedClones, formatNamedClones } from "./cpd-named-clones.ts";
import { listProjectFiles } from "./project-files.ts";
import { runScript } from "./script-entry.ts";

const SOURCE_PATH_PATTERN = /\.(?:cjs|cts|es|es6|js|jsx|mjs|mts|ts|tsx)$/iu;

interface CpdLimits {
  readonly minLines: number;
  readonly minTokens: number;
}

function pathIsWithin(directory: string, path: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

function scanPathWithinProject(
  rootDirectory: string,
  requestedPath: string,
): string {
  const relativePath = relative(
    rootDirectory,
    resolve(rootDirectory, requestedPath),
  );

  if (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `CPD scan path must stay within the project: ${requestedPath}`,
    );
  }

  return relativePath === "" ? "." : relativePath;
}

function requiredLimit(
  config: object,
  key: keyof CpdLimits,
  minimum: number,
): number {
  const value: unknown = Reflect.get(config, key);
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`.jscpd.json must define ${key} as an integer.`);
  }
  return value;
}

async function readCpdLimits(rootDirectory: string): Promise<CpdLimits> {
  const value: unknown = await Bun.file(
    join(rootDirectory, ".jscpd.json"),
  ).json();
  if (typeof value !== "object" || value === null) {
    throw new Error(".jscpd.json must contain an object.");
  }
  return {
    minLines: requiredLimit(value, "minLines", 0),
    minTokens: requiredLimit(value, "minTokens", 1),
  };
}

async function runCpd(): Promise<number> {
  const rootDirectory = resolve(import.meta.dirname, "..");
  const requestedPaths = process.argv.slice(2);
  const unsupportedOption = requestedPaths.find((path) => path.startsWith("-"));
  if (unsupportedOption !== undefined) {
    throw new Error(
      `CPD wrapper does not accept options: ${unsupportedOption}`,
    );
  }
  const scanPaths = (requestedPaths.length === 0 ? ["."] : requestedPaths).map(
    (path) => scanPathWithinProject(rootDirectory, path),
  );
  const projectPaths = await listProjectFiles(rootDirectory);
  const sourcePaths = projectPaths.filter(
    (path) =>
      SOURCE_PATH_PATTERN.test(path) &&
      scanPaths.some((scanPath) =>
        pathIsWithin(
          resolve(rootDirectory, scanPath),
          resolve(rootDirectory, path),
        ),
      ),
  );
  const cpd = Bun.spawn(
    ["bun", "run", "--silent", "cpd:engine", "--", ...scanPaths],
    {
      cwd: rootDirectory,
      stderr: "inherit",
      stdout: "inherit",
    },
  );
  const cpdExitCode = await cpd.exited;

  if (cpdExitCode !== 0 && cpdExitCode !== 1) {
    return cpdExitCode;
  }

  const { minLines, minTokens } = await readCpdLimits(rootDirectory);
  const namedClones = findNamedClones(
    rootDirectory,
    sourcePaths,
    minLines,
    minTokens,
  );
  console.log(formatNamedClones(namedClones));

  return cpdExitCode === 0 && namedClones.length === 0 ? 0 : 1;
}

await runScript(runCpd);
