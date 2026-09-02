import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { listProjectFiles } from "./project-files";

const CACHE_DIRECTORY = "data/check-cache";
const WARM_BUDGET_SECONDS = 5;
const COLD_BUDGET_SECONDS = 60;
const FORMAT_SHARD_COUNT = 4;
const LIGHT_TASK_DELAY_MILLISECONDS = 25_000;
const LINT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

type Command = [string, ...string[]];
interface Task {
  readonly commands: readonly Command[];
  readonly delayMilliseconds?: number;
  readonly name: string;
}
interface TaskResult {
  readonly cacheState: "hit" | "miss";
  readonly durationSeconds: number;
  readonly name: string;
  readonly passed: boolean;
}

async function contentHash(files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of files) {
    const contents = await readFile(path);
    hash.update(String(Buffer.byteLength(path)));
    hash.update(":");
    hash.update(path);
    hash.update(String(contents.byteLength));
    hash.update(":");
    hash.update(contents);
  }
  return hash.digest("hex");
}

function balancedShards(
  files: readonly string[],
  shardCount: number,
): string[][] {
  const shards: string[][] = [];
  const sizes: number[] = [];
  for (let index = 0; index < shardCount; index += 1) {
    shards.push([]);
    sizes.push(0);
  }
  const largestFirst = [...files].sort(
    (left, right) => Bun.file(right).size - Bun.file(left).size,
  );
  for (const file of largestFirst) {
    const smallestSize = Math.min(...sizes);
    const shardIndex = sizes.indexOf(smallestSize);
    const shard = shards[shardIndex];
    if (shard === undefined) {
      throw new Error("Could not select a check shard.");
    }
    shards[shardIndex] = [...shard, file];
    sizes[shardIndex] = smallestSize + Bun.file(file).size;
  }
  return shards;
}

function commandsForFiles(
  executable: string,
  argumentsBeforeFiles: readonly string[],
  shards: readonly (readonly string[])[],
): Command[] {
  return shards.map((files) => [executable, ...argumentsBeforeFiles, ...files]);
}

function eslintScopeCommand(
  tsconfig: string,
  scopeFiles: readonly string[],
): Command {
  return [
    "/usr/bin/env",
    `Q_MUSH_ESLINT_TSCONFIG=${tsconfig}`,
    "bun",
    "node_modules/.bin/eslint",
    "--max-warnings",
    "0",
    ...scopeFiles,
  ];
}

function lintScope(path: string): string {
  const separator = path.indexOf("/");
  return separator === -1 ? "root" : path.slice(0, separator);
}

function scopeLintCommands(files: readonly string[]): Command[] {
  const scopes = new Map<string, string[]>();
  for (const file of files) {
    const scope = lintScope(file);
    scopes.set(scope, [...(scopes.get(scope) ?? []), file]);
  }
  const filesFor = (...names: readonly string[]): string[] =>
    names.flatMap((name) => scopes.get(name) ?? []);
  const syncEngineFiles = filesFor("sync-engine");
  const syncEngineShards = balancedShards(syncEngineFiles, 2);
  const firstSyncEngineShard = syncEngineShards[0];
  const secondSyncEngineShard = syncEngineShards[1];
  if (
    firstSyncEngineShard === undefined ||
    secondSyncEngineShard === undefined
  ) {
    throw new Error("Could not create sync-engine lint shards.");
  }
  return [
    eslintScopeCommand(
      "tsconfig.eslint-sync-engine.json",
      firstSyncEngineShard,
    ),
    eslintScopeCommand(
      "tsconfig.eslint-sync-engine.json",
      secondSyncEngineShard,
    ),
    eslintScopeCommand("tsconfig.eslint-solid.json", filesFor("solid")),
    eslintScopeCommand(
      "tsconfig.eslint-runner-scripts.json",
      filesFor("runner", "scripts"),
    ),
    eslintScopeCommand("tsconfig.eslint-shared.json", filesFor("shared")),
    eslintScopeCommand(
      "tsconfig.eslint-test-root.json",
      filesFor("test", "root"),
    ),
  ];
}

async function cacheHit(name: string, hash: string): Promise<boolean> {
  const file = Bun.file(`${CACHE_DIRECTORY}/${name}`);
  return (await file.exists()) && (await file.text()).trim() === hash;
}

async function runCommand(command: Command): Promise<boolean> {
  const child = Bun.spawn(command, {
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  return (await child.exited) === 0;
}

async function runTask(task: Task, hash: string): Promise<TaskResult> {
  const started = performance.now();
  if (await cacheHit(task.name, hash)) {
    const durationSeconds = (performance.now() - started) / 1_000;
    console.log(
      `[check] ${task.name}: pass (cache hit, ${durationSeconds.toFixed(2)}s)`,
    );
    return {
      cacheState: "hit",
      durationSeconds,
      name: task.name,
      passed: true,
    };
  }

  if (task.delayMilliseconds !== undefined) {
    await Bun.sleep(task.delayMilliseconds);
  }
  console.log(
    `[check] ${task.name}: cache miss; running ${String(task.commands.length)} process(es)`,
  );
  const outcomes = await Promise.all(task.commands.map(runCommand));
  const durationSeconds = (performance.now() - started) / 1_000;
  const passed = outcomes.every(Boolean);
  console.log(
    `[check] ${task.name}: ${passed ? "pass" : "FAIL"} (cache miss, ${durationSeconds.toFixed(2)}s)`,
  );
  return { cacheState: "miss", durationSeconds, name: task.name, passed };
}

function configuredBudget(anyMiss: boolean): number {
  const required = anyMiss ? COLD_BUDGET_SECONDS : WARM_BUDGET_SECONDS;
  const override = Number(Bun.env["CHECK_BUDGET_SECONDS"]);
  return Number.isFinite(override) && override >= 0
    ? Math.min(required, override)
    : required;
}

const started = performance.now();
const files = await listProjectFiles(
  import.meta.dir.replace(/\/scripts$/u, ""),
);
const hash = await contentHash(files);
const lintFiles = files.filter((path) => LINT_EXTENSIONS.has(extname(path)));
const allShards = balancedShards(files, FORMAT_SHARD_COUNT);
const tasks: readonly Task[] = [
  {
    commands: scopeLintCommands(lintFiles),
    name: "lint",
  },
  {
    commands: commandsForFiles(
      "node_modules/.bin/prettier",
      ["--check", "--ignore-unknown"],
      allShards,
    ),
    delayMilliseconds: LIGHT_TASK_DELAY_MILLISECONDS,
    name: "format",
  },
  { commands: [["node_modules/.bin/tsc", "--noEmit"]], name: "typecheck" },
  {
    commands: [["bun", "run", "knip"]],
    delayMilliseconds: LIGHT_TASK_DELAY_MILLISECONDS,
    name: "knip",
  },
  {
    commands: [["bun", "scripts/cpd.ts"]],
    delayMilliseconds: LIGHT_TASK_DELAY_MILLISECONDS,
    name: "cpd",
  },
  {
    commands: [["bun", "scripts/repository-check.ts"]],
    delayMilliseconds: LIGHT_TASK_DELAY_MILLISECONDS,
    name: "repository-check",
  },
];
const results = await Promise.all(tasks.map((task) => runTask(task, hash)));
const durationSeconds = (performance.now() - started) / 1_000;
const anyMiss = results.some((result) => result.cacheState === "miss");
const budgetSeconds = configuredBudget(anyMiss);
const passed = results.every((result) => result.passed);
const withinBudget = durationSeconds <= budgetSeconds;

console.log("\n[check] summary");
for (const result of results) {
  console.log(
    `[check] ${result.name}: ${result.cacheState}, ${result.durationSeconds.toFixed(2)}s, ${result.passed ? "pass" : "FAIL"}`,
  );
}
console.log(
  `[check] total: ${durationSeconds.toFixed(2)}s (budget: ${String(budgetSeconds)}s, ${anyMiss ? "cold/changed" : "all-hit"})`,
);
if (!withinBudget) {
  console.error(
    `[check] FAIL: measured duration ${durationSeconds.toFixed(2)}s exceeded the applied ${String(budgetSeconds)}s budget.`,
  );
}

if (passed && withinBudget) {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  await Promise.all(
    results
      .filter((result) => result.cacheState === "miss")
      .map((result) =>
        writeFile(`${CACHE_DIRECTORY}/${result.name}`, `${hash}\n`),
      ),
  );
} else {
  process.exitCode = 1;
}
