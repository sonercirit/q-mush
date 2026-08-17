import { describe, expect, test } from "vitest";
import {
  MAXIMUM_AGENT_MODEL_OPTIONS,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../../shared/agent-configuration.ts";
import type { AgentSessionToolOption } from "../../shared/agent-tools.ts";
import type { ProviderCredentialSummary } from "../../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../../shared/runner-model.ts";
import { sessionOptionsOutput } from "../../sync-engine/session-agent-options.ts";
import {
  modelOptionIds,
  testModelOption,
  testSessionOptionsInput,
  testSessionOptionsSource,
} from "./session-agent-option-fixtures.ts";
import {
  jsonRecord,
  testArray,
  testRecord,
} from "./session-agent-output-helpers.ts";

const COMPLETE_OPTION_METADATA = {
  truncated: false,
  truncation: { sourceFields: false },
} as const;

interface SessionCredentialOption extends Pick<
  ProviderCredentialSummary,
  "accountId" | "id" | "isDefault" | "label" | "source"
> {
  readonly provider: "openai" | "openrouter";
}

const modelCredential = (
  index: number,
  options: { readonly provider?: "openai" | "openrouter" } = {},
): SessionCredentialOption => ({
  accountId: null,
  id: `credential-${String(index)}`,
  isDefault: false,
  label: `Credential ${String(index)}`,
  provider: options.provider ?? "openai",
  source: "api_key",
});

function parsed(
  input: Parameters<typeof sessionOptionsOutput>[0],
  source: Parameters<typeof sessionOptionsOutput>[1],
): Readonly<Record<string, unknown>> {
  return jsonRecord(sessionOptionsOutput(input, source));
}

function numberedModels(length: number): readonly AgentModelOption[] {
  return Array.from({ length }, (_, index) =>
    testModelOption(`model-${String(index).padStart(2, "0")}`, {
      contextWindow: index + 1,
    }),
  );
}

function modelsWithText(text: string, modalities: boolean) {
  return Array.from({ length: 10 }, (_, index) =>
    testModelOption(`model-${String(index)}`, {
      inputModalities: modalities ? [text] : null,
      label: text,
      outputModalities: modalities ? [text] : null,
    }),
  );
}

function modelOptionsOutput(text: string, modalities: boolean): string {
  return sessionOptionsOutput(
    testSessionOptionsInput("models"),
    testSessionOptionsSource({ models: modelsWithText(text, modalities) }),
  );
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
    const read = parsed(
      testSessionOptionsInput("runners"),
      testSessionOptionsSource({ runners }),
    );

    expect(read).toMatchObject({
      hasNext: true,
      hasPrevious: false,
      page: 1,
      pageSize: 10,
      totalItems: 11,
      totalPages: 2,
      truncated: false,
      truncation: { sourceFields: false },
    });
    expect(testArray(read["items"])).toHaveLength(10);
    expect(JSON.stringify(read)).not.toContain("lastSeenAt");
  });

  test("returns stable non-overlapping first, middle, and last model pages", () => {
    const models = numberedModels(37);
    const request = (page: number) =>
      testSessionOptionsInput("models", {
        credentialId: "credential-1",
        page,
        provider: "openrouter",
      });
    const pages = [1, 2, 3, 4].map((page) =>
      parsed(request(page), testSessionOptionsSource({ models })),
    );

    expect(pages.map(modelOptionIds)).toEqual([
      models.slice(0, 10).map(({ id }) => id),
      models.slice(10, 20).map(({ id }) => id),
      models.slice(20, 30).map(({ id }) => id),
      models.slice(30).map(({ id }) => id),
    ]);
    expect(pages[0]).toMatchObject({
      filters: {
        credentialId: "credential-1",
        provider: "openrouter",
      },
      hasNext: true,
      hasPrevious: false,
      page: 1,
      pageSize: 10,
      totalItems: 37,
      totalPages: 4,
    });
    expect(pages[1]).toMatchObject({
      hasNext: true,
      hasPrevious: true,
      page: 2,
    });
    expect(pages[3]).toMatchObject({
      hasNext: false,
      hasPrevious: true,
      page: 4,
    });
    expect(new Set(pages.flatMap(modelOptionIds)).size).toBe(37);
  });

  test("normalizes Unicode and searches explicit model metadata before paging", () => {
    const models = Array.from({ length: 25 }, (_, index) =>
      testModelOption(`catalog-${String(index).padStart(2, "0")}`, {
        inputModalities: index === 24 ? ["Visión"] : ["text"],
        label: index % 2 === 0 ? `Café Focus ${String(index)}` : "Other",
        pricing:
          index === 23 ? { input: "rare-price-marker" } : { input: "0.1" },
        reasoningEfforts: index === 22 ? ["xhigh"] : [],
      }),
    );
    const request = (page: number) =>
      testSessionOptionsInput("models", {
        credentialId: "credential-2",
        page,
        provider: "openai",
        search: "CAFE FOCUS",
      });
    const first = parsed(request(1), testSessionOptionsSource({ models }));
    const second = parsed(request(2), testSessionOptionsSource({ models }));

    const matchingIds = models.flatMap((model, index) =>
      index % 2 === 0 ? [model.id] : [],
    );
    expect([modelOptionIds(first), modelOptionIds(second)]).toEqual([
      matchingIds.slice(0, 10),
      matchingIds.slice(10),
    ]);
    expect(first).toMatchObject({
      filters: {
        credentialId: "credential-2",
        provider: "openai",
        search: "CAFE FOCUS",
      },
      totalItems: 13,
      totalPages: 2,
    });
    expect(
      modelOptionIds(
        parsed(
          testSessionOptionsInput("models", { search: "VISION" }),
          testSessionOptionsSource({ models }),
        ),
      ),
    ).toEqual(["catalog-24"]);
    expect(
      modelOptionIds(
        parsed(
          testSessionOptionsInput("models", { search: "rare-price-marker" }),
          testSessionOptionsSource({ models }),
        ),
      ),
    ).toEqual(["catalog-23"]);
    expect(
      modelOptionIds(
        parsed(
          testSessionOptionsInput("models", { search: "[object Object]" }),
          testSessionOptionsSource({ models }),
        ),
      ),
    ).toEqual([]);
  });

  test("reports zero model matches and rejects every out-of-range model page", () => {
    const models = numberedModels(21);
    const zero = parsed(
      testSessionOptionsInput("models", {
        credentialId: "credential-3",
        provider: "openai",
        search: "absent",
      }),
      testSessionOptionsSource({ models }),
    );

    expect(zero).toMatchObject({
      filters: {
        credentialId: "credential-3",
        provider: "openai",
        search: "absent",
      },
      hasNext: false,
      hasPrevious: false,
      items: [],
      page: 1,
      totalItems: 0,
      totalPages: 0,
    });
    expect(() =>
      sessionOptionsOutput(
        testSessionOptionsInput("models", { page: 2, search: "absent" }),
        testSessionOptionsSource({ models }),
      ),
    ).toThrow("requested session options page is out of range");
    expect(() =>
      sessionOptionsOutput(
        testSessionOptionsInput("models", { page: 4 }),
        testSessionOptionsSource({ models }),
      ),
    ).toThrow("requested session options page is out of range");
  });

  test("rejects model sources above the catalog option bound", () => {
    const oversizedModels = numberedModels(MAXIMUM_AGENT_MODEL_OPTIONS + 1);
    for (const page of [undefined, { totalItems: 1 }]) {
      expect(() =>
        sessionOptionsOutput(
          testSessionOptionsInput("models"),
          testSessionOptionsSource({
            models: oversizedModels,
            ...(page === undefined ? {} : { page }),
          }),
        ),
      ).toThrow("model catalog has too many options");
    }
  });

  test("validates externally paginated source totals and slices", () => {
    expect(() =>
      sessionOptionsOutput(
        testSessionOptionsInput("credentials"),
        testSessionOptionsSource({ page: { totalItems: -1 } }),
      ),
    ).toThrow("paginated session options total is invalid");
    const emptyCredentials: SessionCredentialOption[] = [];
    const invalidSlices = [
      {
        credentials: Array.from({ length: 11 }, (_, index) =>
          modelCredential(index),
        ),
        page: 1,
      },
      {
        credentials: Array.from({ length: 2 }, (_, index) =>
          modelCredential(index + 10),
        ),
        page: 2,
      },
      { credentials: emptyCredentials, page: 1 },
    ];
    for (const invalid of invalidSlices) {
      expect(() =>
        sessionOptionsOutput(
          testSessionOptionsInput("credentials", { page: invalid.page }),
          testSessionOptionsSource({
            credentials: invalid.credentials,
            page: { totalItems: invalid.credentials.length === 0 ? 1 : 11 },
          }),
        ),
      ).toThrow("paginated session options source is invalid");
    }
  });

  test("searches case-insensitively before pagination", () => {
    const credentials: SessionCredentialOption[] = Array.from(
      { length: 15 },
      (_, index) => ({
        ...modelCredential(index, {
          provider: index % 2 === 0 ? "openai" : "openrouter",
        }),
        label:
          index % 2 === 0
            ? `Team ${String(index)}`
            : `Personal ${String(index)}`,
      }),
    );
    const read = parsed(
      testSessionOptionsInput("credentials", { page: 1, search: "TEAM" }),
      testSessionOptionsSource({ credentials }),
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

  test("rejects page two when a category has no matches", () => {
    expect(() =>
      sessionOptionsOutput(
        testSessionOptionsInput("tools", { page: 2, search: "missing" }),
        testSessionOptionsSource({ tools: [] }),
      ),
    ).toThrow("requested session options page is out of range");
  });

  test("returns model, effort, and tool definition options", () => {
    const models: AgentModelOption[] = Array.from({ length: 11 }, (_, index) =>
      testModelOption(`model-${String(index)}`, {
        contextWindow: 100_000,
        reasoningEfforts: ["high"],
      }),
    );
    const efforts: AgentReasoningEffort[] = ["none", "low", "high"];
    const firstModel = models[0];
    if (firstModel === undefined) {
      throw new Error("The test model catalog is empty");
    }
    models[0] = {
      ...firstModel,
      reasoningEfforts: [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    };
    const tools: AgentSessionToolOption[] = [
      {
        classification: "runner_tool",
        definition: {
          description: "Read files",
          name: "read",
          parameters: {},
        },
        description: "Read files",
        label: "Read",
        name: "read",
      },
    ];

    expect(
      testRecord(
        testArray(
          parsed(
            testSessionOptionsInput("models"),
            testSessionOptionsSource({ models }),
          )["items"],
        )[0],
      )["reasoningEfforts"],
    ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    // Non-positive and fractional catalog limits are dropped, valid ones
    // pass through.
    const boundedLimits = testArray(
      parsed(
        testSessionOptionsInput("models"),
        testSessionOptionsSource({
          models: [
            testModelOption("good", {
              contextWindow: 128_000,
              maxOutputTokens: 64_000,
            }),
            testModelOption("bad", { contextWindow: 0, maxOutputTokens: 1.5 }),
          ],
        }),
      )["items"],
    ).map((item) => [
      testRecord(item)["contextWindow"],
      testRecord(item)["maxOutputTokens"],
    ]);
    expect(boundedLimits).toEqual([
      [128_000, 64_000],
      [null, null],
    ]);
    expect(
      testArray(
        parsed(
          testSessionOptionsInput("reasoning_efforts"),
          testSessionOptionsSource({ reasoningEfforts: efforts }),
        )["items"],
      ),
    ).toEqual([{ effort: "none" }, { effort: "low" }, { effort: "high" }]);
    expect(
      testArray(
        parsed(
          testSessionOptionsInput("tools"),
          testSessionOptionsSource({ tools }),
        )["items"],
      ),
    ).toEqual([
      {
        classification: "runner_tool",
        description: "Read files",
        label: "Read",
        name: "read",
      },
    ]);
  });

  test("preserves serialized pages for the shared final character bound", () => {
    const read = jsonRecord(modelOptionsOutput("x".repeat(3_000), false));
    expect(testArray(read["items"])).toHaveLength(10);
  });

  test("preserves multibyte source fields", () => {
    const serialized = modelOptionsOutput("😀".repeat(250), true);
    const read = jsonRecord(serialized);

    expect(serialized).not.toContain("�");
    expect(read).toMatchObject(COMPLETE_OPTION_METADATA);
  });

  test("preserves externally sourced fields for the shared final bound", () => {
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
        classification: "runner_tool",
        definition: {
          description: huge,
          name: "read",
          parameters: {},
        },
        description: huge,
        label: huge,
        name: "read",
      },
    ];

    for (const [request, options] of [
      [
        testSessionOptionsInput("runners"),
        testSessionOptionsSource({ runners: [runner] }),
      ],
      [
        testSessionOptionsInput("credentials"),
        testSessionOptionsSource({ credentials }),
      ],
      [testSessionOptionsInput("tools"), testSessionOptionsSource({ tools })],
    ] as const) {
      const parsedOutput = jsonRecord(sessionOptionsOutput(request, options));
      expect(parsedOutput).toMatchObject(COMPLETE_OPTION_METADATA);
    }
  });
});
