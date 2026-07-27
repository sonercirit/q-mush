import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

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

class ProviderResponses {
  readonly delays: number[] = [];
  readonly requests: Request[] = [];
  readonly #responses: Response[];

  constructor(responses: Response[]) {
    this.#responses = responses;
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const response = this.#responses.shift();
    this.requests.push(request);
    if (response === undefined) {
      return Promise.reject(
        new RangeError("Missing queued test provider response"),
      );
    }
    return response;
  };

  sleep = (milliseconds: number): Promise<void> => {
    this.delays.push(milliseconds);
    return Promise.resolve();
  };
}

function openRouterModel(
  provider: ProviderResponses,
  deltas?: ProviderTextDelta[],
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: {
      accountId: null,
      secret: "sk-or-secret",
      source: "api_key",
    },
    fetch: provider.fetch,
    model: "openai/gpt-4.1-mini",
    ...(deltas === undefined
      ? {}
      : {
          onDelta: (delta: ProviderTextDelta) => {
            deltas.push(delta);
          },
        }),
    provider: "openrouter",
    sleep: provider.sleep,
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

describe("provider HTTP turn recovery", () => {
  test("resets a partial turn and persists only the recovered tool call", async () => {
    const provider = new ProviderResponses([
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
      const provider = new ProviderResponses([
        first,
        Response.json({ choices: [{ message: { content: "Recovered." } }] }),
      ]);
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

  test("bounds transient retries and preserves sanitized request detail", async () => {
    const leakedKey = "sk-proj-secret123456789";
    const provider = new ProviderResponses(
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
    const provider = new ProviderResponses([
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
    const provider = new ProviderResponses([
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
