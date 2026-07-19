import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT_DIRECTORY = join(import.meta.dir, "../..");
const SCRIPTS_DIRECTORY = join(import.meta.dir, "..");
const sourceProbePath = (fileName: string): string =>
  join(ROOT_DIRECTORY, "src", fileName);
const ESLINT_POLICY_PROBE = sourceProbePath("eslint-policy-probe.ts");
const ESLINT_TSX_POLICY_PROBE = sourceProbePath("eslint-tsx-policy-probe.tsx");
const ESLINT_UNSAFE_TSX_POLICY_PROBE = sourceProbePath(
  "eslint-unsafe-tsx-policy-probe.tsx",
);
const IGNORED_DIRECTORY_PROBE = join(ROOT_DIRECTORY, "eslint-ignore-probe.tgz");
const KNIP_SOURCE_PROBE = join(SCRIPTS_DIRECTORY, "knip-isolation-probe.ts");
const KNIP_TEST_PROBE = join(import.meta.dir, "knip-isolation-probe.test.ts");
const KNIP_TEST_SUPPORT_PROBE = join(import.meta.dir, "knip-isolation-probe");
const KNIP_TEST_HELPER_PROBE = join(KNIP_TEST_SUPPORT_PROBE, "helper.ts");
const RAW_HTML_FILE_PROBE = join(ROOT_DIRECTORY, "raw-html-policy-probe.html");

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

function expectCommandFailure(result: CommandResult): string {
  expect(result.exitCode).toBe(1);
  return result.output;
}

async function removeProbes(): Promise<void> {
  await Promise.all([
    rm(ESLINT_POLICY_PROBE, { force: true }),
    rm(ESLINT_TSX_POLICY_PROBE, { force: true }),
    rm(ESLINT_UNSAFE_TSX_POLICY_PROBE, { force: true }),
    rm(IGNORED_DIRECTORY_PROBE, { force: true, recursive: true }),
    rm(KNIP_SOURCE_PROBE, { force: true }),
    rm(KNIP_TEST_PROBE, { force: true }),
    rm(KNIP_TEST_SUPPORT_PROBE, { force: true, recursive: true }),
    rm(RAW_HTML_FILE_PROBE, { force: true }),
  ]);
}

afterEach(removeProbes);

describe("tooling policies", () => {
  test("ESLint rejects unsafe HTML while allowing TSX", async () => {
    await Promise.all([
      writeFile(
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

declare const container: HTMLElement;
const markup = "<main>Raw markup</main>";
container.innerHTML = markup;

const response = new Response("<main>Raw response</main>");
const templateResponse = new Response(\`<section>\${markup}</section>\`);
const eslint: ESLint | undefined = undefined;
console.log(eslint, response, templateResponse);
`,
      ),
      writeFile(
        ESLINT_TSX_POLICY_PROBE,
        `import { createElement } from "./jsx.ts";

const htmlExample = "<main>Displayed as escaped text</main>";
console.log(<main>{htmlExample}</main>);
`,
      ),
      writeFile(
        ESLINT_UNSAFE_TSX_POLICY_PROBE,
        `import { createElement } from "./jsx.ts";

console.log(<iframe srcDoc="<main>Raw frame</main>"></iframe>);
`,
      ),
    ]);

    const result = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      "--format",
      "json",
      relative(ROOT_DIRECTORY, ESLINT_POLICY_PROBE),
      relative(ROOT_DIRECTORY, ESLINT_UNSAFE_TSX_POLICY_PROBE),
    ]);

    const output = expectCommandFailure(result);
    expect(output).toContain("@typescript-eslint/consistent-type-assertions");
    expect(output).toContain("@typescript-eslint/consistent-type-imports");
    expect(output).toContain("@typescript-eslint/switch-exhaustiveness-check");
    expect(output).toContain("no-restricted-properties");
    expect(output).toContain("no-restricted-syntax");
    expect(output).toContain("HTML-like template");
    expect(output).toContain("JSX attributes");
    expect(output).toContain("TSX instead");

    const tsxResult = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      "--format",
      "json",
      relative(ROOT_DIRECTORY, ESLINT_TSX_POLICY_PROBE),
    ]);
    expect(tsxResult.exitCode).toBe(0);
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

  test("repository check rejects application HTML files", async () => {
    await writeFile(RAW_HTML_FILE_PROBE, "Legacy application page");

    const result = await runCommand(["bun", "run", "repository-check"]);

    const output = expectCommandFailure(result);
    expect(output).toContain("raw-html-policy-probe.html");
    expect(output).toContain("TSX instead");
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
    const productionOutput = expectCommandFailure(productionResult);
    expect(productionOutput).toContain("knip-isolation-probe.ts");
    expect(productionOutput).not.toContain("helper.ts");

    const testResult = await runCommand(["bun", "run", "knip:test"]);
    expect(expectCommandFailure(testResult)).toContain("unusedTestHelper");
  });
});
