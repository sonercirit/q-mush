import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { createChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { TEST_CREDENTIAL_FINGERPRINT } from "./agent-model-credential-fixtures.ts";
import {
  chatCompletionsDone,
  codexOAuthCredential,
} from "./prompt-cache-fixtures.ts";
import {
  completedEventResponse,
  createFakeProviderSockets,
  failWebSocketAttempts,
} from "./provider-recovery-fixtures.ts";

type ModelOptions = Parameters<typeof createChatCompletionsAgentModel>[0];

const SESSION_KEY = "0193dummy-session-id";

function apiKeyChatOptions(
  provider: "generic" | "openai" | "openrouter",
  model: string,
  promptCacheKey: string | undefined,
): Omit<ModelOptions, "fetch" | "toolSettings"> {
  return {
    credential: {
      accountId: null,
      id: "test-api-key-credential",
      ...(provider === "generic"
        ? { baseUrl: "https://generic.example.test/v1" }
        : {}),
      secret: "sk-chat",
      source: "api_key",
    },
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    maxOutputTokens: null,
    model,
    ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
    provider,
  };
}

async function captureChat(
  options: Omit<ModelOptions, "fetch" | "toolSettings">,
): Promise<{ readonly body: unknown; readonly request: Request }> {
  let captured: Request | undefined;
  const model = createChatCompletionsAgentModel({
    toolSettings: DEFAULT_TOOL_SETTINGS,
    ...options,
    fetch: (request) => {
      captured = request;
      return Promise.resolve(Response.json(chatCompletionsDone()));
    },
  });
  await model.complete([{ content: "Hello", role: "user" }]);
  if (captured === undefined) {
    throw new Error("No request was captured");
  }
  return { body: await captured.json(), request: captured };
}

function promptCacheKeyOf(body: unknown): unknown {
  return isRecord(body) ? body["prompt_cache_key"] : undefined;
}

async function markerFreeChatBody(
  provider: "generic" | "openai",
  model: string,
): Promise<unknown> {
  const { body } = await captureChat(
    apiKeyChatOptions(provider, model, SESSION_KEY),
  );
  expect(JSON.stringify(body)).not.toContain("cache_control");
  return body;
}

describe("prompt cache request state", () => {
  test("keys OpenRouter requests to the session and marks 1h breakpoints", async () => {
    const { body } = await captureChat(
      apiKeyChatOptions(
        "openrouter",
        "anthropic/claude-sonnet-4.5",
        SESSION_KEY,
      ),
    );

    expect(promptCacheKeyOf(body)).toBe(SESSION_KEY);
    expect(JSON.stringify(body)).toContain('"ttl":"1h"');
  });

  test("sends prompt_cache_key but no breakpoints to OpenAI api-key chat", async () => {
    const body = await markerFreeChatBody("openai", "gpt-4.1-mini");

    expect(body).toMatchObject({
      messages: [{ role: "system" }, { content: "Hello", role: "user" }],
      prompt_cache_key: SESSION_KEY,
    });
  });

  test("routes Codex requests with the session_id header and body key", async () => {
    const sockets = createFakeProviderSockets();
    let captured: Request | undefined;
    const model = createChatCompletionsAgentModel({
      toolSettings: DEFAULT_TOOL_SETTINGS,
      credential: codexOAuthCredential(),
      credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
      fetch: (request) => {
        captured = request;
        return Promise.resolve(completedEventResponse());
      },
      maxOutputTokens: null,
      model: "gpt-5-codex",
      promptCacheKey: SESSION_KEY,
      provider: "openai",
      sleep: () => Promise.resolve(),
      webSocket: sockets.create,
    });

    const stepPromise = model.complete([{ content: "Hello", role: "user" }]);
    await failWebSocketAttempts(sockets);
    const step = await stepPromise;

    expect(step.content).toBe("Done.");
    expect(captured?.headers.get("session_id")).toBe(SESSION_KEY);
    expect(promptCacheKeyOf(await captured?.json())).toBe(SESSION_KEY);
  });

  test("sends neither breakpoints nor cache key to generic OpenAI chat", async () => {
    // Strict OpenAI-compatible servers reject unknown fields, and local
    // runtimes reject array content carrying cache markers.
    const body = await markerFreeChatBody("generic", "llama-3.3-70b");

    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  test("omits the cache key field when no session key exists", async () => {
    const { body, request } = await captureChat(
      apiKeyChatOptions("openrouter", "openai/gpt-4.1-mini", undefined),
    );

    expect(request.headers.has("session_id")).toBe(false);
    expect(isRecord(body)).toBe(true);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});
