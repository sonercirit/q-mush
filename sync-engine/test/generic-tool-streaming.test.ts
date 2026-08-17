import { expect, test, vi } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import type { ToolStreamDeltaFrame } from "../../shared/tool-stream.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
} from "../../sync-engine/session-agent-models.ts";
import {
  ToolStreamPublisher,
  type ToolStreamTransport,
} from "../../sync-engine/tool-stream-publisher.ts";

const USER_MESSAGE: readonly AgentConversationMessage[] = [
  { content: "Inspect the project", role: "user" },
];
const EXPECTED_TOOL_CALL = {
  arguments: '{"path":"README.md"}',
  id: "call-1",
  name: "read",
};

class RecordingToolStreamTransport implements ToolStreamTransport {
  readonly frames: ToolStreamDeltaFrame[] = [];

  publishToolStream(_userId: string, frame: ToolStreamDeltaFrame): void {
    this.frames.push(frame);
  }
}

function chatEvent(value: unknown): string {
  return ["data: ", JSON.stringify(value), "\n", "\n"].join("");
}

function toolCallChunk(options: {
  readonly arguments: string;
  readonly id?: string;
  readonly name?: string;
}) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: {
                arguments: options.arguments,
                ...(options.name === undefined ? {} : { name: options.name }),
              },
              ...(options.id === undefined ? {} : { id: options.id }),
              index: 0,
            },
          ],
        },
      },
    ],
  };
}

function completeToolCallMessage() {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              function: {
                arguments: EXPECTED_TOOL_CALL.arguments,
                name: EXPECTED_TOOL_CALL.name,
              },
              id: EXPECTED_TOOL_CALL.id,
              type: "function",
            },
          ],
        },
      },
    ],
  };
}

function stagedEventStream(stages: readonly string[]): {
  readonly release: (index: number) => void;
  readonly response: Response;
} {
  const encoder = new TextEncoder();
  const gates = stages.slice(1).map(() => Promise.withResolvers<undefined>());
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(stages[0] ?? ""));
      for (const [index, gate] of gates.entries()) {
        await gate.promise;
        controller.enqueue(encoder.encode(stages[index + 1] ?? ""));
      }
      controller.close();
    },
  });
  return {
    release: (index) => {
      gates[index]?.resolve();
    },
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
  };
}

function genericSession(response: Response): {
  readonly frames: ToolStreamDeltaFrame[];
  readonly run: () => ReturnType<ChatCompletionsAgentModel["complete"]>;
} {
  const transport = new RecordingToolStreamTransport();
  const toolStream = new ToolStreamPublisher({
    sessionId: TEST_SESSION_DETAIL.id,
    streamId: "initial-step",
    transport,
    userId: "user-1",
    workspaceId: TEST_SESSION_DETAIL.workspaceId,
  });
  let fetched = false;
  const factory: AgentModelFactory = (options) =>
    new ChatCompletionsAgentModel({
      ...options,
      fetch: () => {
        if (fetched) {
          return Promise.reject(new Error("Unexpected generic provider retry"));
        }
        fetched = true;
        return Promise.resolve(response);
      },
    });
  const models = createSessionAgentModels({
    agentFile: null,
    credential: {
      accountId: null,
      baseUrl: "https://generic.example.test/v1",
      id: "generic-credential",
      isDefault: false,
      label: "Generic test provider",
      secret: "test-secret",
      source: "api_key",
    },
    detail: {
      ...TEST_SESSION_DETAIL,
      credentialId: "generic-credential",
      model: "generic-test-model",
      provider: "generic",
    },
    factory,
    id: () => "provider-step",
    isCurrent: () => true,
    realtime: undefined,
    streamId: "initial-step",
    toolStream,
    userId: "user-1",
  });

  return {
    frames: transport.frames,
    run: () => {
      models.agent.startStep?.();
      return models.agent.complete(USER_MESSAGE);
    },
  };
}

function expectedFrames(options: {
  readonly arguments: string;
  readonly callId: string;
  readonly name: string;
}): readonly Partial<ToolStreamDeltaFrame>[] {
  return [
    { callId: options.callId, sequence: 0, state: "preparing" },
    {
      callId: options.callId,
      channel: "name",
      content: options.name,
      sequence: 1,
    },
    {
      callId: options.callId,
      channel: "arguments",
      content: options.arguments,
      sequence: 2,
    },
  ];
}

function completeFrames(): readonly Partial<ToolStreamDeltaFrame>[] {
  return expectedFrames({
    arguments: EXPECTED_TOOL_CALL.arguments,
    callId: EXPECTED_TOOL_CALL.id,
    name: EXPECTED_TOOL_CALL.name,
  });
}

function runGenericSession(response: Response): {
  readonly frames: ToolStreamDeltaFrame[];
  readonly pending: ReturnType<ChatCompletionsAgentModel["complete"]>;
} {
  const session = genericSession(response);
  return { frames: session.frames, pending: session.run() };
}

function releaseAndExpect(
  stream: ReturnType<typeof stagedEventStream>,
  session: ReturnType<typeof runGenericSession>,
  releaseIndex: number,
): Promise<void> {
  stream.release(releaseIndex);
  return expect(session.pending).resolves.toMatchObject({
    toolCalls: [EXPECTED_TOOL_CALL],
  });
}

test("generic sessions publish OpenAI-compatible tool fragments before the SSE step completes", async () => {
  const stream = stagedEventStream([
    chatEvent(
      toolCallChunk({
        arguments: '{"path":',
        id: "call-",
        name: "re",
      }),
    ),
    `${chatEvent(
      toolCallChunk({ arguments: '"README.md"}', id: "1", name: "ad" }),
    )}data: [DONE]\n\n`,
  ]);
  const session = runGenericSession(stream.response);

  await vi.waitFor(() => {
    expect(session.frames).toMatchObject(
      expectedFrames({
        arguments: '{"path":',
        callId: "call-",
        name: "re",
      }),
    );
  });

  await releaseAndExpect(stream, session, 0);
  expect(session.frames).toMatchObject([
    ...session.frames.slice(0, 3),
    {
      callId: "call-1",
      previousCallId: "call-",
      sequence: 3,
    },
    { callId: "call-1", channel: "name", content: "ad", sequence: 4 },
    {
      callId: "call-1",
      channel: "arguments",
      content: '"README.md"}',
      sequence: 5,
    },
  ]);
});

test("generic sessions publish a tool call first supplied by the final SSE message", async () => {
  const stream = stagedEventStream([
    chatEvent({ choices: [{ delta: { content: "Checking the project." } }] }),
    chatEvent(completeToolCallMessage()),
    "data: [DONE]\n\n",
  ]);
  const session = runGenericSession(stream.response);

  expect(session.frames).toEqual([]);
  stream.release(0);
  await vi.waitFor(() => {
    expect(session.frames).toHaveLength(3);
    expect(session.frames).toMatchObject(completeFrames());
  });

  await releaseAndExpect(stream, session, 1);
});

test("generic sessions publish a tool call from a non-streamed JSON fallback", async () => {
  const session = runGenericSession(
    Response.json({
      choices: [
        {
          message: {
            ...completeToolCallMessage().choices[0]?.message,
            content: "Reading now.",
            reasoning_content: "Need the project readme.",
          },
        },
      ],
    }),
  );

  await expect(session.pending).resolves.toMatchObject({
    content: "Reading now.",
    thinking: "Need the project readme.",
    toolCalls: [EXPECTED_TOOL_CALL],
  });
  expect(session.frames).toMatchObject(completeFrames());
});
