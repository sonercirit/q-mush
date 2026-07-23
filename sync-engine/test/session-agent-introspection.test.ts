import { describe, expect, test } from "vitest";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import {
  jsonRecord,
  parseTestJson,
  records,
  testArray,
  testRecord,
} from "./session-agent-output-helpers.ts";
import { findToolResultContents } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  completedParentToolOutputs,
  scriptedModel,
  startToolSession,
  toolCall,
  waitForToolResults,
} from "./session-agent-tool-setup.ts";
import { CREDENTIAL_ID, SESSION_ID } from "./session-integration-fixtures.ts";

function credential(
  id: string,
  label: string,
  source: ProviderCredentialAccess["source"] = "api_key",
): ProviderCredentialAccess {
  return {
    accountId: null,
    id,
    isDefault: false,
    label,
    secret: `secret-${id}`,
    source,
  };
}

function modelOption(id: string) {
  return {
    contextWindow: 100_000,
    id,
    inputModalities: ["text"],
    label: `Model ${id}`,
    outputModalities: ["text"],
    pricing: null,
    reasoningEfforts: ["low" as const, "high" as const],
  };
}

function parsedToolOutput(value: unknown, name: string): unknown {
  const [content] = findToolResultContents(value, name);
  return parseTestJson(content ?? "null");
}

describe("session agent introspection tools", () => {
  test("reads selected bounded categories with the effective prompt and tools", async () => {
    const model = scriptedModel([
      {
        content: "Calling a tool.",
        thinking: "hidden reasoning",
        toolCalls: [toolCall("list_sessions", {})],
      },
      {
        content: "Reading bounded context.",
        toolCalls: [
          toolCall("read_session", {
            categories: ["system", "user", "assistant", "tools"],
            limit: 2,
            sessionId: SESSION_ID,
          }),
        ],
      },
      { content: "Inspection complete.", toolCalls: [] },
    ]);
    const agentFileContent = "Always inspect the workspace AGENTS.md first.";
    const setup = await startToolSession(model, {
      agentFile: { content: agentFileContent, name: "AGENTS.md" },
    });
    const detail = await completedParentDetail(setup, "idle");
    const read = testRecord(parsedToolOutput(detail, "read_session"));
    const content = testRecord(read["content"]);
    const serialized = JSON.stringify(read);

    expect(read["session"]).toEqual({
      id: SESSION_ID,
      status: "running",
      title: "Inspect README.md",
    });
    expect(read["metadata"]).toMatchObject({
      matchedRecords: 3,
      requestedLimit: 2,
      returnedRecords: 2,
      selectedCategories: ["system", "user", "assistant", "tools"],
      truncated: true,
    });
    expect(records(content["records"]).map((record) => record["role"])).toEqual(
      ["assistant", "assistant"],
    );
    expect(content["systemPrompt"]).toEqual(
      expect.stringContaining(agentFileContent),
    );
    expect(content["toolDefinitions"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read_session" }),
        expect.objectContaining({ name: "get_session_options" }),
      ]),
    );
    expect(serialized).not.toContain("hidden reasoning");
    expect(serialized).not.toContain("call-list_sessions");
    expect(serialized.length).toBeLessThanOrEqual(32_768);
    setup.database.$client.close();
  });

  test("uses read defaults and validates ownership and every argument", async () => {
    const model = scriptedModel([
      {
        content: "Read defaults, check ownership, then reject bad categories.",
        toolCalls: [
          toolCall("read_session", { sessionId: SESSION_ID }, "read-defaults"),
          toolCall(
            "read_session",
            { sessionId: "unowned-session" },
            "read-unowned",
          ),
          toolCall(
            "read_session",
            {
              categories: [],
              limit: 101,
              sessionId: SESSION_ID,
            },
            "read-invalid",
          ),
        ],
      },
      { content: "Validation complete.", toolCalls: [] },
    ]);
    const { outputs, setup } = await completedParentToolOutputs(
      model,
      "read_session",
    );
    const defaults = testRecord(parseTestJson(outputs[0] ?? "null"));

    expect(defaults["metadata"]).toMatchObject({
      requestedLimit: 20,
      selectedCategories: ["user", "assistant"],
    });
    expect(outputs[1]).toContain("Session not found");
    expect(outputs[2]).toContain("read_session arguments are invalid");
    setup.database.$client.close();
  });

  test("discovers generic spawn options for multiple providers with pagination", async () => {
    const openAiCredentials = [
      {
        ...credential(CREDENTIAL_ID, "Primary OpenAI"),
        secret: "provider-secret",
      },
      ...Array.from({ length: 10 }, (_, index) =>
        credential(`openai-${String(index)}`, `OpenAI ${String(index)}`),
      ),
    ];
    const openRouterCredentials = Array.from({ length: 11 }, (_, index) =>
      credential(
        `openrouter-${String(index)}`,
        `OpenRouter ${String(index)}`,
        "oauth",
      ),
    );
    const openAiModels = Array.from({ length: 23 }, (_, index) =>
      modelOption(`gpt-${String(index)}`),
    );
    const openRouterModels = Array.from({ length: 24 }, (_, index) =>
      modelOption(`vendor/model-${String(index)}`),
    );
    const model = scriptedModel([
      {
        content: "Discovering credentials.",
        toolCalls: [
          toolCall(
            "get_session_options",
            {
              category: "credentials",
              page: 2,
              search: "OPENROUTER",
            },
            "options-credentials",
          ),
        ],
      },
      {
        content: "Discovering OpenAI models.",
        toolCalls: [
          toolCall(
            "get_session_options",
            {
              category: "models",
              credentialId: CREDENTIAL_ID,
              page: 2,
              provider: "openai",
            },
            "options-openai-models",
          ),
        ],
      },
      {
        content: "Discovering OpenRouter models.",
        toolCalls: [
          toolCall(
            "get_session_options",
            {
              category: "models",
              credentialId: "openrouter-0",
              page: 3,
              provider: "openrouter",
            },
            "options-openrouter-models",
          ),
        ],
      },
      {
        content: "Discovering static options.",
        toolCalls: [
          toolCall(
            "parallel",
            {
              tool_uses: [
                {
                  parameters: { category: "runners" },
                  recipient_name: "get_session_options",
                },
                {
                  parameters: { category: "reasoning_efforts" },
                  recipient_name: "get_session_options",
                },
                {
                  parameters: { category: "tools", search: "session" },
                  recipient_name: "get_session_options",
                },
              ],
            },
            "parallel-options",
          ),
        ],
      },
      { content: "Discovery complete.", toolCalls: [] },
    ]);
    const setup = await startToolSession(
      model,
      {
        credentials: {
          openai: openAiCredentials,
          openrouter: openRouterCredentials,
        },
      },
      (provider) =>
        Promise.resolve({
          defaultModel:
            provider === "openai"
              ? (openAiModels[0]?.id ?? null)
              : (openRouterModels[0]?.id ?? null),
          models: provider === "openai" ? openAiModels : openRouterModels,
        }),
    );
    const detail = await waitForToolResults(setup, "get_session_options", 3);
    const outputs = findToolResultContents(detail, "get_session_options").map(
      jsonRecord,
    );

    expect(outputs[0]).toMatchObject({
      hasNext: false,
      page: 2,
      pageSize: 10,
      totalItems: 11,
      totalPages: 2,
    });
    expect(outputs[0]?.["hasPrevious"]).toBe(true);
    expect(testArray(outputs[0]?.["items"])).toHaveLength(1);
    expect(JSON.stringify(outputs[0])).not.toContain("secret-openrouter");
    expect(outputs[1]).toMatchObject({
      page: 2,
      totalItems: 23,
      totalPages: 3,
    });
    expect(testArray(outputs[1]?.["items"])).toHaveLength(10);
    expect(outputs[2]).toMatchObject({
      page: 3,
      totalItems: 24,
      totalPages: 3,
    });
    expect(testArray(outputs[2]?.["items"])).toHaveLength(4);
    const parallel = records(parsedToolOutput(detail, "parallel"));
    expect(parallel.map((result) => result["recipient_name"])).toEqual([
      "get_session_options",
      "get_session_options",
      "get_session_options",
    ]);
    setup.database.$client.close();
  });

  test("validates option category, provider, credential, page, and search", async () => {
    const invalidCalls = [
      { category: "unknown" },
      { category: "models", credentialId: "missing", provider: "openai" },
      { category: "models", credentialId: CREDENTIAL_ID, provider: "unknown" },
      { category: "tools", page: 0 },
      { category: "tools", page: 99 },
      { category: "runners", search: " ".repeat(101) },
    ];
    const turns = invalidCalls.map((arguments_, index) => ({
      content: "Checking invalid options.",
      toolCalls: [
        toolCall(
          "get_session_options",
          arguments_,
          `invalid-options-${String(index)}`,
        ),
      ],
    }));
    turns.push({ content: "All option validations returned.", toolCalls: [] });
    const model = scriptedModel(turns);
    const setup = await startToolSession(model);
    const detail = await waitForToolResults(
      setup,
      "get_session_options",
      invalidCalls.length,
    );
    const outputs = findToolResultContents(detail, "get_session_options");
    if (outputs.length !== invalidCalls.length) {
      throw new Error(
        `Unexpected validation session: ${JSON.stringify(detail)}`,
      );
    }

    expect(outputs).toHaveLength(invalidCalls.length);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("arguments are invalid"),
        expect.stringContaining("unavailable"),
        expect.stringContaining("out of range"),
      ]),
    );
    expect(outputs.filter((value) => value.startsWith("Error:"))).toHaveLength(
      invalidCalls.length,
    );
    setup.database.$client.close();
  });
});
