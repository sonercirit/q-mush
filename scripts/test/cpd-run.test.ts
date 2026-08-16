import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCpd, type CpdDependencies } from "../cpd-run.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

interface DependencyProbe {
  readonly dependencies: CpdDependencies;
  readonly enginePaths: string[][];
  readonly namedSourcePaths: string[][];
  readonly output: string[];
}

function dependencyProbe(options?: {
  readonly engineExitCode?: number;
  readonly namedCloneCount?: number;
  readonly projectPaths?: readonly string[];
}): DependencyProbe {
  const enginePaths: string[][] = [];
  const namedSourcePaths: string[][] = [];
  const output: string[] = [];
  const cloneCount = options?.namedCloneCount ?? 0;
  const dependencies: CpdDependencies = {
    listProjectFiles: () => Promise.resolve([...(options?.projectPaths ?? [])]),
    runEngine: (_rootDirectory, paths) => {
      enginePaths.push([...paths]);
      return Promise.resolve(options?.engineExitCode ?? 0);
    },
    namedClones: {
      scan: ({ sourcePaths }) => {
        namedSourcePaths.push([...sourcePaths]);
        return {
          cloneCount,
          report: `named clone count: ${String(cloneCount)}`,
        };
      },
    },
    writeOutput: (message) => {
      output.push(message);
    },
  };

  return { dependencies, enginePaths, namedSourcePaths, output };
}

async function writeLimits(directory: string, value: unknown): Promise<void> {
  await writeFile(join(directory, ".jscpd.json"), JSON.stringify(value));
}

async function runWithLimits(
  directory: string,
  probe: DependencyProbe,
  paths: readonly string[] = [],
): Promise<number> {
  await writeLimits(directory, { minLines: 1, minTokens: 20 });
  return runCpd(directory, paths, probe.dependencies);
}

describe("CPD wrapper", () => {
  test("normalizes scan roots without turning dash-prefixed paths into options", async () => {
    await withTemporaryDirectory("q-mush-cpd-run-paths-", async (directory) => {
      const probe = dependencyProbe({
        projectPaths: [
          "-scan/first.ts",
          "-scan/nested/second.tsx",
          "-scan/notes.txt",
          "outside.ts",
        ],
      });

      expect(await runWithLimits(directory, probe, ["./-scan"])).toBe(0);
      expect(probe.enginePaths).toEqual([["./-scan"]]);
      expect(probe.namedSourcePaths).toEqual([
        ["-scan/first.ts", "-scan/nested/second.tsx"],
      ]);
    });
  });

  test.each([
    ["engine option", ["--min-tokens"], "does not accept options"],
    ["parent traversal", ["../outside"], "must stay within the project"],
  ])("rejects %s before dispatch", async (_label, paths, message) => {
    await withTemporaryDirectory(
      "q-mush-cpd-run-reject-",
      async (directory) => {
        const probe = dependencyProbe();

        await expect(
          runCpd(directory, paths, probe.dependencies),
        ).rejects.toThrow(message);
        expect(probe.enginePaths).toEqual([]);
      },
    );
  });

  test("validates native CPD token and line limits", async () => {
    await withTemporaryDirectory(
      "q-mush-cpd-run-limits-",
      async (directory) => {
        const probe = dependencyProbe();
        const invalidLimits = [
          null,
          [],
          {},
          { minLines: -1, minTokens: 20 },
          { minLines: 1.5, minTokens: 20 },
          { minLines: 1, minTokens: 0 },
        ];

        for (const value of invalidLimits) {
          await writeLimits(directory, value);
          await expect(
            runCpd(directory, [], probe.dependencies),
          ).rejects.toThrow(/\.jscpd\.json/u);
        }
        expect(probe.enginePaths).toEqual([]);
        expect(probe.namedSourcePaths).toEqual([]);
      },
    );
  });

  test("passes through native engine failures without running the named pass", async () => {
    await withTemporaryDirectory(
      "q-mush-cpd-run-engine-",
      async (directory) => {
        const probe = dependencyProbe({ engineExitCode: 2 });

        await writeLimits(directory, { minLines: 1, minTokens: 20 });
        expect(await runCpd(directory, [], probe.dependencies)).toBe(2);
        expect(probe.namedSourcePaths).toEqual([]);
        expect(probe.output).toEqual([]);
      },
    );
  });

  test.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ])(
    "combines native exit %i and %i named clones into exit %i",
    async (engineExitCode, namedCloneCount, expectedExitCode) => {
      await withTemporaryDirectory(
        "q-mush-cpd-run-exit-",
        async (directory) => {
          const probe = dependencyProbe({ engineExitCode, namedCloneCount });

          expect(await runWithLimits(directory, probe)).toBe(expectedExitCode);
          expect(probe.output).toEqual([
            `named clone count: ${String(namedCloneCount)}`,
          ]);
        },
      );
    },
  );
});
