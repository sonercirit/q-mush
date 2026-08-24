import { describe, expect, test, vi } from "vitest";
import {
  runAgentLoop,
  type AgentModelStep,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { recordingSleep } from "../../shared/test/websocket-fixtures.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  createChatCompletionsAgentModel,
  type ChatCompletionsAgentModel,
} from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import {
  TEST_CREDENTIAL_FINGERPRINT,
  testApiKeyCredential,
} from "./agent-model-credential-fixtures.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";
import { cachedTextMessage } from "./prompt-cache-fixtures.ts";
import {
  createFakeProviderSockets,
  failWebSocketAttempts,
  recordDelay,
  type FakeProviderSockets,
} from "./provider-recovery-fixtures.ts";

const FIRST_REQUEST_ID = "d128368f-4052-4f00-9233-61153d3f5953";
const SECOND_REQUEST_ID = "5a18ebce-f9b5-4375-9beb-833abb711910";
const USER_MESSAGE = [{ content: "Hello", role: "user" as const }];

function chatEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function textEvent(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

function toolEvent(id: string): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: '{"path":"README.md"}', name: "read" },
              id,
              index: 0,
            },
          ],
        },
      },
    ],
  };
}

function errorEvent(options: {
  readonly code: number;
  readonly id?: string;
  readonly message: string;
}): unknown {
  return {
    choices: [{ delta: { content: "" }, finish_reason: "error", index: 0 }],
    error: {
      code: options.code,
      message: options.message,
      metadata: { error_type: "provider_unavailable" },
    },
    id: options.id ?? FIRST_REQUEST_ID,
  };
}

function eventStream(
  events: readonly unknown[],
  options: { readonly complete?: boolean; readonly retryAfter?: string } = {},
): Response {
  const body = `${events.map(chatEvent).join("")}${options.complete === false ? "" : "data: [DONE]\n\n"}`;
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      ...(options.retryAfter === undefined
        ? {}
        : { "retry-after": options.retryAfter }),
    },
  });
}

interface ProviderResponses {
  readonly delays: number[];
  readonly requests: Request[];
  readonly fetch: (request: Request) => Promise<Response>;
  sleep: (milliseconds: number) => Promise<void>;
}

function createProviderResponses(
  responses: Response[],
  beforeFetch?: () => Promise<void>,
): ProviderResponses {
  const delays: number[] = [];
  const requests: Request[] = [];
  return {
    delays,
    requests,
    fetch: async (request) => {
      await beforeFetch?.();
      const response = responses.shift();
      requests.push(request);
      if (response === undefined) {
        throw new RangeError("Missing queued test provider response");
      }
      return response;
    },
    sleep: recordingSleep(delays),
  };
}

function openRouterModel(
  provider: ProviderResponses,
  deltas?: ProviderTextDelta[],
  onRequestState?: (state: "active" | "admission") => void,
): ChatCompletionsAgentModel {
  return createChatCompletionsAgentModel({
    credential: testApiKeyCredential("sk-or-secret", {
      id: "test-credential",
    }),
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    fetch: provider.fetch,
    maxOutputTokens: null,
    model: "openai/gpt-4.1-mini",
    ...(onRequestState === undefined ? {} : { onRequestState }),
    ...(deltas === undefined
      ? {}
      : {
          onDelta: (delta: ProviderTextDelta) => {
            deltas.push(delta);
          },
        }),
    provider: "openrouter",
    sleep: provider.sleep,
    toolSettings: DEFAULT_TOOL_SETTINGS,
  });
}

function interruptedEventStream(content: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(chatEvent(textEvent(content))));
          return;
        }
        controller.error(new TypeError("Socket reset while reading"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function resetDeltas(
  deltas: readonly ProviderTextDelta[],
): ProviderTextDelta[] {
  return deltas.filter(({ reset }) => reset === true);
}

describe("provider HTTP step recovery", () => {
  test("transfers stalled-admission ownership to a healthy HTTP fallback", async () => {
    const sockets = createFakeProviderSockets();
    const states: ("active" | "admission")[] = [];
    const controller = new AbortController();
    let releaseHeaders: (() => void) | undefined;
    const headers = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    const model = createChatCompletionsAgentModel({
      credential: { accountId: null, secret: "sk-openai", source: "api_key" },
      fetch: async () => {
        await headers;
        return eventStream([textEvent("Done.")]);
      },
      maxOutputTokens: null,
      model: "gpt-test",
      onRequestState: (state) => states.push(state),
      provider: "openai",
      sleep: recordDelay([]),
      toolSettings: DEFAULT_TOOL_SETTINGS,
      webSocket: sockets.create,
    });

    const completion = model.complete(USER_MESSAGE, controller.signal);
    await failWebSocketAttempts(sockets);
    await vi.waitFor(() => {
      expect(states.at(-1)).toBe("active");
    });
    expect(states).toEqual([
      "admission",
      "admission",
      "admission",
      "admission",
      "active",
    ]);

    // An active HTTP header wait remains provider-owned after WebSocket
    // admission fallback, so the liveness watchdog does not abort it.
    expect(controller.signal.aborted).toBe(false);
    releaseHeaders?.();
    await expect(completion).resolves.toMatchObject({ content: "Done." });
  });
  test("leaves a long HTTP header wait outside bounded admission", async () => {
    const states: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeaders = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    const retryResponse = eventStream([
      errorEvent({ code: 502, message: "Retry" }),
    ]);
    const provider = createProviderResponses(
      [retryResponse, eventStream([textEvent("Done.")])],
      async () => {
        attempts += 1;
        if (attempts === 1) await firstHeaders;
      },
    );
    const model = openRouterModel(provider, undefined, (state) => {
      states.push(state);
    });

    const completion = model.complete(USER_MESSAGE);
    await Promise.resolve();
    expect(states).toEqual(["active"]);
    releaseFirst?.();
    await completion;
    expect(states).toEqual(["active"]);
  });

  test("resets a partial step and persists only the recovered tool call", async () => {
    const provider = createProviderResponses([
      eventStream([
        textEvent("Discarded partial output."),
        toolEvent("discarded-call"),
        errorEvent({ code: 502, message: "Upstream provider unavailable" }),
      ]),
      eventStream([
        textEvent("Using the recovered call."),
        toolEvent("final-call"),
      ]),
      eventStream([textEvent("Done.")]),
    ]);
    const deltas: ProviderTextDelta[] = [];
    const recorded: AgentRecordedMessage[] = [];
    const executed: string[] = [];

    const record = (messages: readonly AgentRecordedMessage[]): void => {
      recorded.push(...messages);
    };
    await runAgentLoop({
      executeTool: async (call) => {
        executed.push(call.id);
        await Promise.resolve();
        return "# Q Mush";
      },
      initialMessages: USER_MESSAGE,
      model: openRouterModel(provider, deltas),
      recordMessage: record,
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.delays).toEqual([1_000]);
    expect(executed).toEqual(["final-call"]);
    expect(recorded).toContainEqual({
      content: "Using the recovered call.",
      role: "assistant",
      toolCalls: [
        {
          arguments: '{"path":"README.md"}',
          id: "final-call",
          name: "read",
        },
      ],
    });
    expect(JSON.stringify(recorded)).not.toContain("Discarded partial output.");
    expect(deltas.map(({ content }) => content)).toEqual([
      "Discarded partial output.",
      "",
      "",
      "Using the recovered call.",
      "",
      "Done.",
    ]);
    expect(resetDeltas(deltas)).toHaveLength(1);
  });

  function recoveredResponse(): Response {
    return Response.json({ choices: [{ message: { content: "Recovered." } }] });
  }

  function oauthHttpRecoveryModel(
    provider: ProviderResponses,
    refreshes: string[],
  ): ChatCompletionsAgentModel {
    return createChatCompletionsAgentModel({
      credential: {
        accountId: "account",
        secret: createOpenAiOAuthSecret(),
        source: "oauth",
      },
      fetch: provider.fetch,
      maxOutputTokens: null,
      model: "gpt-5-codex",
      provider: "openai",
      refreshCredential: (credential) => {
        refreshes.push(credential.secret);
        return Promise.resolve({
          ...credential,
          secret: JSON.stringify({
            access: "refreshed-access",
            expires: 1_800_000_000_000,
            refresh: "refreshed-refresh",
          }),
        });
      },
      sleep: provider.sleep,
      toolSettings: DEFAULT_TOOL_SETTINGS,
    });
  }

  function expectHttpOAuthRecovery(
    provider: ProviderResponses,
    sockets: FakeProviderSockets,
    refreshes: readonly string[],
  ): void {
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.headers.get("authorization")).toContain(
      "oauth-access-token",
    );
    expect(provider.requests[1]?.headers.get("authorization")).toBe(
      "Bearer refreshed-access",
    );
    expect(refreshes).toHaveLength(1);
    expect(sockets.created).toHaveLength(0);
  }

  function httpOAuthRecovery(responses: readonly Response[]): {
    readonly pending: Promise<AgentModelStep>;
    readonly provider: ProviderResponses;
    readonly refreshes: readonly string[];
    readonly sockets: FakeProviderSockets;
  } {
    const provider = createProviderResponses([...responses]);
    const refreshes: string[] = [];
    const sockets = createFakeProviderSockets();
    const model = oauthHttpRecoveryModel(provider, refreshes);
    const pending = model.complete(USER_MESSAGE);
    return { pending, provider, refreshes, sockets };
  }

  const unauthorizedResponse = (error: string): Response =>
    Response.json({ error }, { status: 401 });

  async function expectHttpRecoveryResult(
    setup: ReturnType<typeof httpOAuthRecovery>,
    succeeds: boolean,
  ): Promise<void> {
    if (succeeds) {
      await expect(setup.pending).resolves.toMatchObject({
        content: "Recovered.",
      });
    } else {
      await expect(setup.pending).rejects.toMatchObject({ status: 401 });
    }
    expectHttpOAuthRecovery(setup.provider, setup.sockets, setup.refreshes);
  }

  test("forces one OAuth refresh after an HTTP 401 and retries with the refreshed token", async () => {
    const setup = httpOAuthRecovery([
      unauthorizedResponse("revoked"),
      recoveredResponse(),
    ]);

    await expectHttpRecoveryResult(setup, true);
  });

  test("never loops after the retried HTTP request also returns 401", async () => {
    const setup = httpOAuthRecovery([
      unauthorizedResponse("revoked"),
      unauthorizedResponse("still revoked"),
    ]);

    await expectHttpRecoveryResult(setup, false);
  });

  test("recovers from interrupted, early-EOF, and truncated accepted bodies", async () => {
    const cases: readonly {
      readonly expectedDelay: number;
      readonly first: Response;
    }[] = [
      { expectedDelay: 1_000, first: interruptedEventStream("Interrupted.") },
      {
        expectedDelay: 3_000,
        first: eventStream([textEvent("Incomplete.")], {
          complete: false,
          retryAfter: "3",
        }),
      },
      {
        expectedDelay: 1_000,
        first: new Response('{"choices":[', {
          headers: { "content-type": "application/json" },
        }),
      },
    ];

    for (const { expectedDelay, first } of cases) {
      const provider = createProviderResponses([first, recoveredResponse()]);
      const deltas: ProviderTextDelta[] = [];

      expect(
        await openRouterModel(provider, deltas).complete(USER_MESSAGE),
      ).toMatchObject({ content: "Recovered." });
      expect(provider.requests).toHaveLength(2);
      expect(provider.delays).toEqual([expectedDelay]);
      if (deltas.length > 0) {
        expect(deltas).toContainEqual({
          content: "",
          reset: true,
          thinking: "",
        });
      }
    }
  });

  test("repairs malformed replayed tool calls before sending", async () => {
    const provider = createProviderResponses([recoveredResponse()]);

    await openRouterModel(provider).complete([
      ...USER_MESSAGE,
      {
        content: "```text\nFix\n```",
        role: "assistant",
        toolCalls: [
          { arguments: "", id: "", name: "" },
          { arguments: "", id: "repaired-call", name: "read" },
          { arguments: "{}", id: "dangling-call", name: "read" },
        ],
      },
      {
        content: "# Q Mush",
        role: "tool",
        toolCallId: "repaired-call",
        toolName: "read",
      },
    ]);

    const body: unknown = await provider.requests[0]?.json();
    expect(body).toMatchObject({
      messages: [
        { role: "system" },
        cachedTextMessage("user", "Hello"),
        {
          content: "```text\nFix\n```",
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: "{}", name: "read" },
              id: "repaired-call",
              type: "function",
            },
          ],
        },
        {
          ...cachedTextMessage("tool", "# Q Mush"),
          tool_call_id: "repaired-call",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("dangling-call");
  });

  test("surfaces OpenRouter's nested provider error detail", async () => {
    const raw = JSON.stringify({
      error: {
        message:
          "An assistant message with tool_calls must be followed by matching tool results.",
        type: "invalid_request_error",
      },
    });
    const provider = createProviderResponses([
      Response.json(
        {
          error: {
            code: 400,
            message: "Provider returned error",
            metadata: { provider_name: "Example", raw },
          },
        },
        { status: 400 },
      ),
    ]);
    const failure = await captureRejection(
      openRouterModel(provider).complete(USER_MESSAGE),
    );

    expect(requireError(failure).message).toContain("Provider returned error");
    expect(requireError(failure).message).toContain(
      "An assistant message with tool_calls must be followed by matching tool results.",
    );
  });

  test("bounds transient retries and preserves sanitized request detail", async () => {
    const leakedKey = "sk-proj-secret123456789";
    const provider = createProviderResponses(
      Array.from({ length: 4 }, () =>
        eventStream([
          textEvent("Partial."),
          errorEvent({
            code: 503,
            id: SECOND_REQUEST_ID,
            message: `Temporary failure for ${leakedKey}`,
          }),
        ]),
      ),
    );
    const deltas: ProviderTextDelta[] = [];
    const transient = openRouterModel(provider, deltas).complete(USER_MESSAGE);
    const transientFailure = await captureRejection(transient);
    const message = requireError(transientFailure).message;

    expect(provider.requests).toHaveLength(4);

    expect(provider.delays).toEqual([1_000, 2_000, 4_000]);
    expect(resetDeltas(deltas)).toHaveLength(4);
    expect(message).toContain(SECOND_REQUEST_ID);
    expect(message).not.toContain(leakedKey);
  });

  test("does not retry permanent errors", async () => {
    const provider = createProviderResponses([
      eventStream([
        errorEvent({
          code: 401,
          id: SECOND_REQUEST_ID,
          message: "Invalid API key",
        }),
      ]),
    ]);
    const permanent = openRouterModel(provider).complete(USER_MESSAGE);
    const permanentFailure = await captureRejection(permanent);
    const message = requireError(permanentFailure).message;

    expect(provider.requests).toHaveLength(1);
    expect(provider.delays).toEqual([]);
    expect(message).toContain("Invalid API key");
    expect(message).toContain(SECOND_REQUEST_ID);
  });

  test("aborts during stream retry backoff", async () => {
    const controller = new AbortController();
    const provider = createProviderResponses([
      eventStream([errorEvent({ code: 502, message: "Unavailable" })]),
    ]);
    provider.sleep = async (milliseconds: number): Promise<void> => {
      expect(milliseconds).toBe(1_000);
      controller.abort();
      await Promise.resolve();
      throw new DOMException("Stopped", "AbortError");
    };
    const pending = openRouterModel(provider).complete(
      USER_MESSAGE,
      controller.signal,
    );
    const error = await captureRejection(pending);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(provider.requests).toHaveLength(1);
  });
});
