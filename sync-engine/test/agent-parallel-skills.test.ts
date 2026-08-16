import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { createParallelToolUses } from "../../shared/test/parallel-fixtures.ts";
import { createAgentSkills } from "../../sync-engine/agent-skills.ts";
import {
  testBraveSearchSkill,
  type BraveSearchExecute,
} from "./agent-skill-test-helpers.ts";
import { captureRejection } from "./promise-test-helpers.ts";

function indexedCalls(count: number, recipientName: string) {
  return createParallelToolUses(count, () => recipientName);
}

function mixedIndexedCalls(count: number) {
  return createParallelToolUses(count, (index) =>
    index % 2 === 0 ? "read" : "brave_search",
  );
}

function invalidParallelCalls(parameters: unknown, recipientName: string) {
  return [
    { marker: "invalid", parameters, recipient_name: recipientName },
    { marker: "control", parameters: {}, recipient_name: "read" },
  ];
}

function testSkills(options: {
  readonly braveSearch?: BraveSearchExecute;
  readonly executeTool?: (
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly tools?: Parameters<typeof createAgentSkills>[0]["tools"];
}) {
  return createAgentSkills({
    braveSearch: testBraveSearchSkill(
      (arguments_) =>
        options.braveSearch?.(arguments_) ?? Promise.resolve("unused"),
    ),
    executeTool:
      options.executeTool ?? (() => Promise.resolve("unused runner output")),
    tools: options.tools ?? ["read", "parallel"],
    userId: "user-id",
  });
}

describe("agent parallel skill execution", () => {
  test("executes mixed parallel tools and skills without dispatching the wrapper", async () => {
    const searchCalls: Readonly<Record<string, unknown>>[] = [];
    const runnerCalls: string[] = [];
    const completions: string[] = [];
    let releaseSearch: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    const skills = testSkills({
      braveSearch: (arguments_) => {
        searchCalls.push(arguments_);
        return new Promise<string>((resolve) => {
          releaseSearch = () => {
            completions.push("brave_search");
            resolve(JSON.stringify(arguments_));
          };
        });
      },
      executeTool: (name, arguments_) => {
        runnerCalls.push(name);
        return new Promise<string>((resolve) => {
          releaseTool = () => {
            completions.push(name);
            resolve(JSON.stringify(arguments_));
          };
        });
      },
      tools: ["read", "parallel", "brave_search"],
    });

    const output = skills.execute("parallel", {
      tool_uses: [
        {
          parameters: { query: "Bun" },
          recipient_name: "brave_search",
        },
        {
          parameters: { path: "README.md" },
          recipient_name: "read",
        },
      ],
    });

    expect(searchCalls).toEqual([{ query: "Bun" }]);
    expect(runnerCalls).toEqual(["read"]);
    releaseTool?.();
    await Promise.resolve();
    expect(completions).toEqual(["read"]);
    releaseSearch?.();
    expect(JSON.parse((await output) ?? "null")).toEqual([
      {
        output: '{"query":"Bun"}',
        recipient_name: "brave_search",
      },
      {
        output: '{"path":"README.md"}',
        recipient_name: "read",
      },
    ]);
  });

  test("accepts more than eight mixed calls with bounded concurrency and input ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];
    const trackCall = async (
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<number> => {
      const index = Number(arguments_["index"]);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(index);
      await Bun.sleep(index % 3);
      active -= 1;
      return index;
    };
    const skills = testSkills({
      braveSearch: async (arguments_) => {
        const index = await trackCall(arguments_);
        return `skill-${String(index)}`;
      },
      executeTool: async (name, arguments_) => {
        const index = await trackCall(arguments_);
        if (index === 11) {
          throw new Error("tool failed");
        }
        return `${name}-${String(index)}`;
      },
      tools: ["read", "parallel", "brave_search", "list_sessions"],
    });
    const calls = indexedCalls(24, "read").map((call, index) => ({
      ...call,
      recipient_name:
        index % 3 === 0
          ? "brave_search"
          : index % 3 === 1
            ? call.recipient_name
            : "list_sessions",
    }));
    const output = await skills.execute("parallel", { tool_uses: calls });
    const results: unknown = JSON.parse(output ?? "null");

    expect(started).toHaveLength(24);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(24);
    expect(Array.isArray(results) ? results[0] : undefined).toEqual({
      output: "skill-0",
      recipient_name: "brave_search",
    });
    expect(Array.isArray(results) ? results[1] : undefined).toEqual({
      output: "read-1",
      recipient_name: "read",
    });
    expect(Array.isArray(results) ? results[2] : undefined).toEqual({
      output: "list_sessions-2",
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[11] : undefined).toEqual({
      error: "tool failed",
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[23] : undefined).toEqual({
      output: "list_sessions-23",
      recipient_name: "list_sessions",
    });
  });

  test("bounds parallel skill output without dropping the final result", async () => {
    const skills = testSkills({
      braveSearch: () => Promise.resolve("x".repeat(60 * 1_024)),
      executeTool: () => Promise.resolve("x".repeat(60 * 1_024)),
      tools: ["read", "parallel", "brave_search"],
    });
    const output = await skills.execute("parallel", {
      tool_uses: mixedIndexedCalls(20),
    });

    expect(Buffer.byteLength(output ?? "", "utf8")).toBeLessThanOrEqual(
      256 * 1_024,
    );
    expect(output).toContain("[parallel output truncated]");
    const results: unknown = JSON.parse(output ?? "null");
    expect(Array.isArray(results) ? results.at(-1) : undefined).toMatchObject({
      recipient_name: "brave_search",
    });
  });

  test("propagates cancellation and stops scheduling parallel calls", async () => {
    const controller = new AbortController();
    let scheduled = 0;
    const skills = testSkills({
      executeTool: async (_name, _arguments, signal) => {
        scheduled += 1;
        if (scheduled === 4) {
          controller.abort();
        }
        await Bun.sleep(1);
        if (signal?.aborted === true) {
          throw new DOMException("stopped", "AbortError");
        }
        return "unexpected";
      },
    });
    const rejection = await captureRejection(
      skills.execute(
        "parallel",
        {
          tool_uses: indexedCalls(20, "read"),
        },
        controller.signal,
      ) ?? Promise.resolve("missing"),
    );

    expect(rejection).toBeInstanceOf(DOMException);
    expect(scheduled).not.toBe(20);
  });

  test("rejects malformed, single-call, and recursively nested parallel input", () => {
    const skills = testSkills({});

    expect(
      skills.execute("parallel", {
        tool_uses: [{ parameters: {}, recipient_name: "read" }],
      }),
    ).toBeUndefined();
    for (const toolUses of [
      invalidParallelCalls({}, "parallel"),
      invalidParallelCalls([], "read"),
    ]) {
      expect(
        skills.execute("parallel", { tool_uses: toolUses }),
      ).toBeUndefined();
    }
  });

  test("rejects disabled recipients inside parallel calls", async () => {
    let searchCalled = false;
    let runnerCall: string | undefined;
    const skills = testSkills({
      braveSearch: () => {
        searchCalled = true;
        return Promise.resolve("unexpected search result");
      },
      executeTool: (name) => {
        runnerCall = name;
        return Promise.resolve("enabled runner result");
      },
    });

    const output = await skills.execute("parallel", {
      tool_uses: [
        { parameters: { path: "README.md" }, recipient_name: "read" },
        { parameters: { query: "disabled" }, recipient_name: "brave_search" },
      ],
    });

    expect(searchCalled).toBe(false);
    expect(runnerCall).toBe("read");
    expect(JSON.parse(output ?? "null")).toEqual([
      { output: "enabled runner result", recipient_name: "read" },
      {
        output: "Error: brave_search is not enabled for this session.",
        recipient_name: "brave_search",
      },
    ]);
  });
});
