import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");
const SCRIPTS_DIRECTORY = join(import.meta.dirname, "..");
const ESLINT_PROBE_DIRECTORY = join(ROOT_DIRECTORY, "solid", "test");
const sourceProbePath = (fileName: string): string =>
  join(ESLINT_PROBE_DIRECTORY, fileName);
const ESLINT_POLICY_PROBE = sourceProbePath("eslint-policy-probe.ts");
const ESLINT_IMPORT_POLICY_PROBE = sourceProbePath(
  "eslint-import-policy-probe.ts",
);
const ESLINT_VALID_IMPORT_POLICY_PROBE = sourceProbePath(
  "eslint-valid-import-policy-probe.ts",
);
const ESLINT_SOLID_POLICY_PROBE = sourceProbePath(
  "eslint-solid-policy-probe.tsx",
);
const ESLINT_TSX_POLICY_PROBE = sourceProbePath("eslint-tsx-policy-probe.tsx");
const ESLINT_UNSAFE_TSX_POLICY_PROBE = sourceProbePath(
  "eslint-unsafe-tsx-policy-probe.tsx",
);
const IGNORED_DIRECTORY_PROBE = join(ROOT_DIRECTORY, "eslint-ignore-probe.tgz");
const KNIP_SOURCE_PROBE = join(SCRIPTS_DIRECTORY, "knip-isolation-probe.ts");
const KNIP_TEST_PROBE = join(
  import.meta.dirname,
  "knip-isolation-probe.test.ts",
);
const KNIP_TEST_SUPPORT_PROBE = join(
  import.meta.dirname,
  "knip-isolation-probe",
);
const KNIP_TEST_HELPER_PROBE = join(KNIP_TEST_SUPPORT_PROBE, "helper.ts");
const CPD_IMPORT_PROBES = [
  sourceProbePath("cpd-import-policy-probe-a.ts"),
  sourceProbePath("cpd-import-policy-probe-b.ts"),
];
const CPD_DASH_DIRECTORY = join(ROOT_DIRECTORY, "-cpd-path-probe");
const CPD_DASH_PROBES = [
  join(CPD_DASH_DIRECTORY, "first.ts"),
  join(CPD_DASH_DIRECTORY, "second.ts"),
];
const RAW_HTML_FILE_PROBE = join(ROOT_DIRECTORY, "raw-html-policy-probe.html");

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

function runCpdImportProbes(): Promise<CommandResult> {
  return runCommand([
    "bun",
    "run",
    "scripts/cpd.ts",
    ...CPD_IMPORT_PROBES.map((probe) => relative(ROOT_DIRECTORY, probe)),
  ]);
}

async function removeProbes(): Promise<void> {
  await Promise.all([
    rm(ESLINT_POLICY_PROBE, { force: true }),
    rm(ESLINT_IMPORT_POLICY_PROBE, { force: true }),
    rm(ESLINT_VALID_IMPORT_POLICY_PROBE, { force: true }),
    rm(ESLINT_SOLID_POLICY_PROBE, { force: true }),
    rm(ESLINT_TSX_POLICY_PROBE, { force: true }),
    rm(ESLINT_UNSAFE_TSX_POLICY_PROBE, { force: true }),
    rm(IGNORED_DIRECTORY_PROBE, { force: true, recursive: true }),
    rm(KNIP_SOURCE_PROBE, { force: true }),
    rm(KNIP_TEST_PROBE, { force: true }),
    rm(KNIP_TEST_SUPPORT_PROBE, { force: true, recursive: true }),
    ...CPD_IMPORT_PROBES.map((probe) => rm(probe, { force: true })),
    rm(CPD_DASH_DIRECTORY, { force: true, recursive: true }),
    rm(RAW_HTML_FILE_PROBE, { force: true }),
  ]);
}

afterEach(removeProbes);

describe("tooling policies", () => {
  // These probes launch full type-aware ESLint/Knip processes. Under a full
  // Vitest shard they can exceed the ordinary unit-test budget while the same
  // assertions complete reliably when run alone.
  vi.setConfig({ testTimeout: 60_000 });

  test("ESLint rejects unsafe HTML while allowing TSX", async () => {
    await Promise.all([
      writeFile(
        ESLINT_POLICY_PROBE,
        `import { ESLint } from "eslint";

declare const choice: "first" | "second";
declare const unknownValue: unknown;
declare function consume(value: string): void;

consume(unknownValue as string);

class DeclaredService {}
const ExpressedService = class {};

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
console.log(
  eslint,
  response,
  templateResponse,
  DeclaredService,
  ExpressedService,
);
`,
      ),
      writeFile(
        ESLINT_TSX_POLICY_PROBE,
        `const htmlExample = "<main>Displayed as escaped text</main>";
console.log(<main>{htmlExample}</main>);
`,
      ),
      writeFile(
        ESLINT_UNSAFE_TSX_POLICY_PROBE,
        `console.log(<iframe srcdoc="<main>Raw frame</main>"></iframe>);
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
    expect(output).toContain("Switch statements are forbidden");
    expect(output).toContain("Class declarations are forbidden");
    expect(output).toContain("Class expressions are forbidden");
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

  test("ESLint rejects Solid reactivity snapshots", async () => {
    await writeFile(
      ESLINT_SOLID_POLICY_PROBE,
      [
        'import type { JSX } from "solid-js";',
        "",
        "function Label(props: { readonly text: string }): JSX.Element {",
        "  return <span>{props.text}</span>;",
        "}",
        "",
        "function BrokenLabel(props: { readonly text: string }): JSX.Element {",
        "  const snapshot = { ...props };",
        "  const text = props.text;",
        "  return <Label {...snapshot} text={text} />;",
        "}",
        "",
        "console.log(BrokenLabel);",
        "",
      ].join("\n"),
    );

    const result = await runCommand(
      ["node", "node_modules/eslint/bin/eslint.js", "--format", "json"].concat(
        relative(ROOT_DIRECTORY, ESLINT_SOLID_POLICY_PROBE),
      ),
    );

    const output = expectCommandFailure(result);
    expect(output).toContain("q-mush/no-props-object-spread");
    expect(output).toContain("solid/reactivity");
  });

  test("ESLint enforces canonical named imports", async () => {
    await Promise.all([
      writeFile(
        ESLINT_IMPORT_POLICY_PROBE,
        `import type { AppDatabase } from "../../shared/database.ts";
import { createDatabase } from "../../shared/database.ts";
import { setTimeout as sleep } from "node:timers/promises";
import filePath = require("node:path");
import * as fileSystem from "node:fs";
import operatingSystem from "node:os";
import packageMetadata from "../../package.json" with { type: "json" };
import "../../shared/routes.ts";

type RouteModule = typeof import("./routes.ts");
const database: AppDatabase = createDatabase(":memory:");
const routeModule: Promise<RouteModule> = import("./routes.ts");
console.log(
  database,
  filePath,
  fileSystem.constants,
  operatingSystem,
  packageMetadata,
  routeModule,
  sleep,
);
`,
      ),
      writeFile(
        ESLINT_VALID_IMPORT_POLICY_PROBE,
        `import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import "../styles.css";

const database: AppDatabase = createDatabase(":memory:");
console.log(database);
`,
      ),
    ]);

    const invalidResult = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      "--format",
      "json",
      relative(ROOT_DIRECTORY, ESLINT_IMPORT_POLICY_PROBE),
    ]);
    const output = expectCommandFailure(invalidResult);
    expect(output).toContain("q-mush/canonical-imports");
    expect(output).toContain("no-duplicate-imports");
    expect(output).toContain("Default imports");
    expect(output).toContain("Dynamic imports");
    expect(output).toContain("Import attributes");
    expect(output).toContain("Import-equals declarations");
    expect(output).toContain("import() types");
    expect(output).toContain("side effects");

    const validResult = await runCommand([
      "node",
      "node_modules/eslint/bin/eslint.js",
      relative(ROOT_DIRECTORY, ESLINT_VALID_IMPORT_POLICY_PROBE),
    ]);
    expect(validResult.exitCode).toBe(0);
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

  test("CPD ignores imports and owned identifier spelling", async () => {
    const duplicatedImports = `import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "vitest";
`;
    await Promise.all(
      CPD_IMPORT_PROBES.map((probe) => writeFile(probe, duplicatedImports)),
    );

    const importResult = await runCpdImportProbes();
    expect(importResult.exitCode).toBe(0);
    expect(importResult.output).toContain("Found 0 clones");

    const firstDuplicatedImplementation = `export function normalizeDuplicatedValue(
  input: string,
): string {
  const normalized = input.trim().toLowerCase();
  return normalized.split("").reverse().join("");
}
`;
    const renamedDuplicatedImplementation = `export function transformDuplicatedValue(
  source: string,
): string {
  const result = source.trim().toLowerCase();
  return result.split("").reverse().join("");
}
`;
    await Promise.all(
      CPD_IMPORT_PROBES.map((probe) =>
        writeFile(
          probe,
          probe === CPD_IMPORT_PROBES[0]
            ? firstDuplicatedImplementation
            : renamedDuplicatedImplementation,
        ),
      ),
    );

    const duplicateResult = await runCpdImportProbes();
    expect(expectCommandFailure(duplicateResult)).toContain("Found 1 clones");
  });

  test("CPD keeps normalized dash-prefixed paths as paths", async () => {
    await mkdir(CPD_DASH_DIRECTORY);
    await Promise.all(
      CPD_DASH_PROBES.map((probe) =>
        writeFile(probe, "export const uniqueValue = 1;\n"),
      ),
    );

    const result = await runCommand([
      "bun",
      "run",
      "scripts/cpd.ts",
      `./${relative(ROOT_DIRECTORY, CPD_DASH_DIRECTORY)}`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Found 0 clones");
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
