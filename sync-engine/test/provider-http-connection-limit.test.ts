import { describe, expect, test } from "vitest";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

const USER_MESSAGE = [{ content: "Hello", role: "user" as const }];

function connectionLimitResponse(): Response {
  const event = {
    error: {
      code: "websocket_connection_limit_reached",
      message: "Create a new websocket connection to continue.",
      type: "invalid_request_error",
    },
    type: "error",
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("provider HTTP connection-limit classification", () => {
  test("does not retry a WebSocket-only connection-limit code", async () => {
    let fetchCount = 0;
    const delays: number[] = [];
    const modelOptions: ConstructorParameters<
      typeof ChatCompletionsAgentModel
    >[0] = {
      credential: Object.freeze({
        accountId: null,
        secret: "sk-or-secret",
        source: "api_key" as const,
      }),
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve(connectionLimitResponse());
      },
      maxOutputTokens: null,
      model: "openai/gpt-4.1-mini",
      provider: "openrouter",
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    };
    const model = new ChatCompletionsAgentModel({
      ...modelOptions,
      toolSettings: DEFAULT_TOOL_SETTINGS,
    });
    const failure = await captureRejection(model.complete(USER_MESSAGE));

    expect(fetchCount).toBe(1);
    expect(delays).toEqual([]);
    expect(requireError(failure).message).toContain(
      "websocket_connection_limit_reached",
    );
  });
});
