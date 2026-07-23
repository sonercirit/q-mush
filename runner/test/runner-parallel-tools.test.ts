import { expect, test } from "vitest";
import {
  executeRunnerTool,
  type RunnerParallelExecutionOptions,
} from "../../runner/runner-tools.ts";
import { createParallelToolUses } from "../../shared/test/parallel-fixtures.ts";
import { observeRunnerRejection } from "./promise-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const workspace = useTemporaryDirectories("q-mush-parallel-tools-test-");
const PARALLEL_TOOL = "parallel";

const writeCalls = (count: number) =>
  createParallelToolUses(count, () => "write");

function executeParallelWrites(
  root: string,
  count: number,
  signal?: AbortSignal,
  execution?: RunnerParallelExecutionOptions,
): Promise<string> {
  return executeRunnerTool(
    root,
    PARALLEL_TOOL,
    { tool_uses: writeCalls(count) },
    signal,
    execution,
  );
}

test("runner parallel accepts more than eight calls in input order", async () => {
  const output = await executeParallelWrites(await workspace(), 24);
  const results: unknown = JSON.parse(output);

  expect(results).toHaveLength(24);
  const expected = writeCalls(24).map(({ parameters: { content, path } }) => ({
    output: `Wrote ${String(content.length)} bytes to ${path}.`,
    recipient_name: "write",
  }));
  expect(results).toEqual(expected);
});

test("runner parallel bounds simultaneous work without dropping calls", async () => {
  const root = await workspace();
  let active = 0;
  let maximumActive = 0;
  const events: string[] = [];
  const output = await executeParallelWrites(root, 20, undefined, {
    execute: async (_root, toolUse) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const content = toolUse.parameters["content"];
      events.push(`start:${typeof content === "string" ? content : ""}`);
      await Bun.sleep(1);
      active -= 1;
      return String(toolUse.parameters["content"]);
    },
  });

  expect(maximumActive).toBe(4);
  expect(events.filter((event) => event.startsWith("start:"))).toHaveLength(20);
  const expected = writeCalls(20).map(({ parameters: { content } }) => ({
    output: content,
    recipient_name: "write",
  }));
  expect(JSON.parse(output)).toEqual(expected);
});

test("runner parallel captures failures and truncates output", async () => {
  const root = await workspace();
  const output = await executeParallelWrites(root, 20, undefined, {
    execute: (_root, toolUse) => {
      const index = Number(toolUse.parameters["content"]);
      return index === 3
        ? Promise.reject(new Error("child failed"))
        : Promise.resolve("x".repeat(60 * 1_024));
    },
  });
  const results: unknown = JSON.parse(output);
  const item = (index: number): unknown =>
    Array.isArray(results) ? results[index] : undefined;

  expect(Buffer.byteLength(output, "utf8")).toBeLessThan(262_145);
  expect(output).toContain("[parallel output truncated]");
  expect(results).toHaveLength(20);
  expect(item(3)).toEqual({
    error: "child failed",
    recipient_name: "write",
  });
  expect(item(19)).toMatchObject({ recipient_name: "write" });
});

test("runner parallel stops scheduling queued calls after cancellation", async () => {
  const root = await workspace();
  const controller = new AbortController();
  let started = 0;
  const gate = Promise.withResolvers<undefined>();
  const running = executeParallelWrites(root, 20, controller.signal, {
    execute: async () => {
      started += 1;
      if (started === 4) {
        controller.abort();
        gate.resolve(undefined);
      }
      await gate.promise;
      throw new Error("The runner command was stopped");
    },
  });
  const error = await observeRunnerRejection(running);

  expect(error).toBeInstanceOf(Error);
  expect(started).toBeLessThan(20);
});

test("runner parallel keeps the minimum and rejects nesting", async () => {
  const root = await workspace();
  const tooFew = await observeRunnerRejection(
    executeRunnerTool(root, PARALLEL_TOOL, {
      batch: "too-few",
      tool_uses: writeCalls(1),
    }),
  );
  const nested = await observeRunnerRejection(
    executeRunnerTool(root, PARALLEL_TOOL, {
      batch: "nested",
      tool_uses: [
        { parameters: {}, recipient_name: PARALLEL_TOOL },
        { parameters: {}, recipient_name: "read" },
      ],
    }),
  );

  expect(tooFew).toMatchObject({
    message: "Tool argument tool_uses must contain at least 2 calls",
  });
  expect(nested).toMatchObject({
    message: "Unknown parallel recipient: parallel",
  });
});
