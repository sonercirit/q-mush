import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findNamedClones, formatNamedClones } from "./cpd-named-clones.ts";
import { listProjectFiles } from "./project-files.ts";

const SOURCE_PATH_PATTERN = /\.(?:cjs|cts|es|es6|js|jsx|mjs|mts|ts|tsx)$/iu;
const CPD_EXECUTABLE = fileURLToPath(import.meta.resolve("cpd/run-cpd.js"));

interface CpdLimits {
  readonly minLines: number;
  readonly minTokens: number;
}

interface NamedCloneScan {
  readonly cloneCount: number;
  readonly report: string;
}

export interface CpdDependencies {
  readonly listProjectFiles: (rootDirectory: string) => Promise<string[]>;
  readonly runEngine: (
    rootDirectory: string,
    scanPaths: readonly string[],
  ) => Promise<number>;
  readonly namedClones: {
    scan(options: {
      readonly minLines: number;
      readonly minTokens: number;
      readonly rootDirectory: string;
      readonly sourcePaths: readonly string[];
    }): NamedCloneScan;
  };
  readonly writeOutput: (message: string) => void;
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
    throw new Error(
      `.jscpd.json must define ${key} as an integer of at least ${String(minimum)}.`,
    );
  }
  return value;
}

async function readCpdLimits(rootDirectory: string): Promise<CpdLimits> {
  const value: unknown = await Bun.file(
    join(rootDirectory, ".jscpd.json"),
  ).json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".jscpd.json must contain an object.");
  }
  return {
    minLines: requiredLimit(value, "minLines", 0),
    minTokens: requiredLimit(value, "minTokens", 1),
  };
}

function enginePaths(scanPaths: readonly string[]): string[] {
  return scanPaths.map((path) => (path.startsWith("-") ? `./${path}` : path));
}

const defaultCpdDependencies: CpdDependencies = {
  listProjectFiles,
  runEngine: async (rootDirectory, scanPaths) => {
    const cpd = Bun.spawn([process.execPath, CPD_EXECUTABLE, ...scanPaths], {
      cwd: rootDirectory,
      stderr: "inherit",
      stdout: "inherit",
    });
    return cpd.exited;
  },
  namedClones: {
    scan: ({ rootDirectory, sourcePaths, minLines, minTokens }) => {
      const clones = findNamedClones(
        rootDirectory,
        sourcePaths,
        minLines,
        minTokens,
      );
      return { cloneCount: clones.length, report: formatNamedClones(clones) };
    },
  },
  writeOutput: console.log,
};

export async function runCpd(
  rootDirectory: string,
  requestedPaths: readonly string[],
  dependencies: CpdDependencies = defaultCpdDependencies,
): Promise<number> {
  const unsupportedOption = requestedPaths.find((path) => path.startsWith("-"));
  if (unsupportedOption !== undefined) {
    throw new Error(
      `CPD wrapper does not accept options: ${unsupportedOption}`,
    );
  }
  const scanPaths = (requestedPaths.length === 0 ? ["."] : requestedPaths).map(
    (path) => scanPathWithinProject(rootDirectory, path),
  );
  const projectPaths = await dependencies.listProjectFiles(rootDirectory);
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
  const cpdExitCode = await dependencies.runEngine(
    rootDirectory,
    enginePaths(scanPaths),
  );

  if (cpdExitCode !== 0 && cpdExitCode !== 1) {
    return cpdExitCode;
  }

  const { minLines, minTokens } = await readCpdLimits(rootDirectory);
  const namedScan = dependencies.namedClones.scan({
    minLines,
    minTokens,
    rootDirectory,
    sourcePaths,
  });
  dependencies.writeOutput(namedScan.report);

  return cpdExitCode === 0 && namedScan.cloneCount === 0 ? 0 : 1;
}
