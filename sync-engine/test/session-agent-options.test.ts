import { describe, expect, test } from "vitest";
import type { AgentReasoningEffort } from "../../shared/agent-configuration.ts";
import type { AgentSessionToolOption } from "../../shared/agent-tools.ts";
import type { ProviderCredentialSummary } from "../../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../../shared/runner-model.ts";
import {
  sessionOptionsOutput,
  type GetSessionOptionsToolInput,
  type SessionOptionsSource,
} from "../../sync-engine/session-agent-options.ts";
import { jsonRecord, testArray } from "./session-agent-output-helpers.ts";

const MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS = 24_000;

interface SessionCredentialOption extends Pick<
  ProviderCredentialSummary,
  "accountId" | "id" | "isDefault" | "label" | "source"
> {
  readonly provider: "openai" | "openrouter";
}

const input = (
  category: GetSessionOptionsToolInput["category"],
  overrides: Partial<GetSessionOptionsToolInput> = {},
): GetSessionOptionsToolInput => ({ category, page: 1, ...overrides });

function source(
  overrides: Partial<SessionOptionsSource> = {},
): SessionOptionsSource {
  return {
    credentials: [],
    models: [],
    reasoningEfforts: [],
    runners: [],
    tools: [],
    ...overrides,
  };
}

function parsed(
  request: GetSessionOptionsToolInput,
  options: SessionOptionsSource,
): Readonly<Record<string, unknown>> {
  return jsonRecord(sessionOptionsOutput(request, options));
}

describe("session option pagination", () => {
  test("uses one ten-item pagination contract for every category", () => {
    const runners: RunnerSummary[] = Array.from({ length: 12 }, (_, index) => ({
      architecture: "x64",
      id: `runner-${String(index + 1)}`,
      isDefault: index === 0,
      lastSeenAt: 1,
      name: `Runner ${String(index + 1)}`,
      platform: "linux",
      status: index === 11 ? "offline" : "online",
    }));
    const read = parsed(input("runners"), source({ runners }));

    expect(read).toMatchObject({
      hasNext: true,
      hasPrevious: false,
      page: 1,
      pageSize: 10,
      totalItems: 11,
      totalPages: 2,
    });
    expect(testArray(read["items"])).toHaveLength(10);
    expect(JSON.stringify(read)).not.toContain("lastSeenAt");
  });

  test("searches case-insensitively before pagination", () => {
    const credentials: SessionCredentialOption[] = Array.from(
      { length: 15 },
      (_, index) => ({
        accountId: null,
        id: `credential-${String(index)}`,
        isDefault: false,
        label:
          index % 2 === 0
            ? `Team ${String(index)}`
            : `Personal ${String(index)}`,
        provider: index % 2 === 0 ? "openai" : "openrouter",
        source: "api_key",
      }),
    );
    const read = parsed(
      input("credentials", { page: 1, search: "TEAM" }),
      source({ credentials }),
    );

    expect(read).toMatchObject({
      hasNext: false,
      hasPrevious: false,
      page: 1,
      totalItems: 8,
      totalPages: 1,
    });
    expect(testArray(read["items"])).toHaveLength(8);
    expect(JSON.stringify(read)).not.toContain("secret");
  });

  test("returns model, effort, and tool definition options", () => {
    const models = Array.from({ length: 11 }, (_, index) => ({
      contextWindow: 100_000,
      id: `model-${String(index)}`,
      inputModalities: ["text"],
      label: `Model ${String(index)}`,
      outputModalities: ["text"],
      pricing: null,
      reasoningEfforts: ["high" as const],
    }));
    const efforts: AgentReasoningEffort[] = ["none", "low", "high"];
    const tools: AgentSessionToolOption[] = [
      { description: "Read files", kind: "tool", label: "Read", name: "read" },
    ];

    expect(
      testArray(parsed(input("models"), source({ models }))["items"]),
    ).toHaveLength(10);
    expect(
      testArray(
        parsed(
          input("reasoning_efforts"),
          source({ reasoningEfforts: efforts }),
        )["items"],
      ),
    ).toEqual([{ effort: "none" }, { effort: "low" }, { effort: "high" }]);
    expect(
      testArray(parsed(input("tools"), source({ tools }))["items"]),
    ).toEqual(tools);
  });

  test("bounds serialized pages", () => {
    const models = Array.from({ length: 10 }, (_, index) => ({
      contextWindow: null,
      id: `model-${String(index)}`,
      inputModalities: ["x".repeat(3_000)],
      label: "l".repeat(3_000),
      outputModalities: null,
      pricing: null,
      reasoningEfforts: [],
    }));

    const serialized = sessionOptionsOutput(
      input("models"),
      source({ models }),
    );
    expect(serialized.length).toBeLessThanOrEqual(
      MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS,
    );
    expect(testArray(jsonRecord(serialized)["items"])).toHaveLength(10);
    expect(MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS).toBeLessThan(32_768);
  });

  test("bounds every externally sourced option field", () => {
    const huge = "x".repeat(20_000);
    const runner: RunnerSummary = {
      architecture: huge,
      id: huge,
      isDefault: false,
      lastSeenAt: 1,
      name: huge,
      platform: huge,
      status: "online",
    };
    const credentials: SessionCredentialOption[] = [
      {
        accountId: huge,
        id: huge,
        isDefault: false,
        label: huge,
        provider: "openai",
        source: "api_key",
      },
    ];
    const tools: AgentSessionToolOption[] = [
      {
        description: huge,
        kind: "tool",
        label: huge,
        name: "read",
      },
    ];

    for (const [request, options] of [
      [input("runners"), source({ runners: [runner] })],
      [input("credentials"), source({ credentials })],
      [input("tools"), source({ tools })],
    ] as const) {
      expect(sessionOptionsOutput(request, options).length).toBeLessThanOrEqual(
        MAXIMUM_SESSION_OPTIONS_OUTPUT_CHARACTERS,
      );
    }
  });
});
