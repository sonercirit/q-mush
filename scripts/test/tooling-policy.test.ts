import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT_DIRECTORY = join(import.meta.dir, "../..");
const SCRIPTS_DIRECTORY = join(import.meta.dir, "..");
const ESLINT_POLICY_PROBE = join(import.meta.dir, "eslint-policy-probe.ts");
const IGNORED_DIRECTORY_PROBE = join(ROOT_DIRECTORY, "eslint-ignore-probe.tgz");
const KNIP_SOURCE_PROBE = join(SCRIPTS_DIRECTORY, "knip-isolation-probe.ts");
const KNIP_TEST_PROBE = join(import.meta.dir, "knip-isolation-probe.test.ts");
const KNIP_TEST_SUPPORT_PROBE = join(import.meta.dir, "knip-isolation-probe");
const KNIP_TEST_HELPER_PROBE = join(KNIP_TEST_SUPPORT_PROBE, "helper.ts");

setDefaultTimeout(15_000);

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const process = Bun.spawn(command, {
    cwd: ROOT_DIRECTORY,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function removeProbes(): Promise<void> {
  await Promise.all([
    rm(ESLINT_POLICY_PROBE, { force: true }),
    rm(IGNORED_DIRECTORY_PROBE, { force: true, recursive: true }),
    rm(KNIP_SOURCE_PROBE, { force: true }),
    rm(KNIP_TEST_PROBE, { force: true }),
    rm(KNIP_TEST_SUPPORT_PROBE, { force: true, recursive: true }),
  ]);
}

afterEach(removeProbes);

describe("tooling policies", () => {
  test("ESLint rejects assertions, non-exhaustive switches, and value imports used only as types", async () => {
    await writeFile(
      ESLINT_POLICY_PROBE,
      `import { ESLint } from "eslint";

declare const choice: "first" | "second";
declare const unknownValue: unknown;
declare function consume(value: string): void;

consume(unknownValue as string);

switch (choice) {
  case "first":
    console.log(choice);
}

const eslint: ESLint | undefined = undefined;
console.log(eslint);
`,
    );

    const result = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      "--format",
      "json",
      relative(ROOT_DIRECTORY, ESLINT_POLICY_PROBE),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "@typescript-eslint/consistent-type-assertions",
    );
    expect(result.output).toContain(
      "@typescript-eslint/consistent-type-imports",
    );
    expect(result.output).toContain(
      "@typescript-eslint/switch-exhaustiveness-check",
    );
  });

  test("ESLint reads generated-output ignores from .gitignore", async () => {
    const probe = join(IGNORED_DIRECTORY_PROBE, "invalid.js");
    await mkdir(IGNORED_DIRECTORY_PROBE);
    await writeFile(probe, "const =;");

    const result = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      "--no-warn-ignored",
      relative(ROOT_DIRECTORY, probe),
    ]);

    expect(result.exitCode).toBe(0);
  });

  test("Knip isolates production usage while checking test code", async () => {
    await mkdir(KNIP_TEST_SUPPORT_PROBE, { recursive: true });
    await Promise.all([
      writeFile(
        KNIP_SOURCE_PROBE,
        'export const usedOnlyByTest = "production probe";\n',
      ),
      writeFile(
        KNIP_TEST_PROBE,
        `import { usedOnlyByTest } from "../knip-isolation-probe.ts";
import { usedTestHelper } from "./knip-isolation-probe/helper.ts";

console.log(usedOnlyByTest, usedTestHelper);
`,
      ),
      writeFile(
        KNIP_TEST_HELPER_PROBE,
        `export const usedTestHelper = "used test helper";
export const unusedTestHelper = "unused test helper";
`,
      ),
    ]);

    const productionResult = await runCommand([
      "bun",
      "run",
      "knip:production",
    ]);
    expect(productionResult.exitCode).toBe(1);
    expect(productionResult.output).toContain("knip-isolation-probe.ts");
    expect(productionResult.output).not.toContain("helper.ts");

    const testResult = await runCommand(["bun", "run", "knip:test"]);
    expect(testResult.exitCode).toBe(1);
    expect(testResult.output).toContain("unusedTestHelper");
  });
});
