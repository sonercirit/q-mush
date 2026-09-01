import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { listProjectFiles } from "./project-files";

const CACHE_DIRECTORY = "data/check-cache";
const WARM_BUDGET_SECONDS = 5;
const COLD_BUDGET_SECONDS = 60;
const LINT_SHARD_COUNT = 4;
const FORMAT_SHARD_COUNT = 4;
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
const lintShards = balancedShards(lintFiles, LINT_SHARD_COUNT);
const tasks: readonly Task[] = [
  {
    commands: commandsForFiles(
      "node_modules/.bin/eslint",
      ["--max-warnings", "0"],
      lintShards,
    ),
    name: "lint",
  },
  {
    commands: commandsForFiles(
      "node_modules/.bin/prettier",
      ["--check", "--ignore-unknown"],
      allShards,
    ),
    name: "format",
  },
  { commands: [["bun", "run", "typecheck"]], name: "typecheck" },
  { commands: [["bun", "run", "knip"]], name: "knip" },
  { commands: [["bun", "run", "cpd"]], name: "cpd" },
  {
    commands: [["bun", "run", "repository-check"]],
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
