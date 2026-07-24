import { expect, test } from "vitest";
import { runAgentLoop } from "../../shared/agent-loop.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createProviderStreamAccumulator } from "../provider-stream.ts";
import { RealtimeHub, type RealtimeSocket } from "../realtime-hub.ts";
import { createSessionAgentModels } from "../session-agent-models.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import { ToolStreamPublisher } from "../tool-stream-publisher.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const RUNNER_ID = "runner-stream";
const SESSION_ID = "session-stream";

function runnerCommand() {
  const location = process.cwd();
  return {
    arguments: { stream: true },
    runnerId: RUNNER_ID,
    sessionId: SESSION_ID,
    tool: "bash",
    workingDirectory: location,
  };
}

function chatToolChunk(
  call: Readonly<{
    arguments: string;
    id?: string;
    name: string;
  }>,
): Readonly<Record<string, unknown>> {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: call.arguments, name: call.name },
              ...(call.id === undefined ? {} : { id: call.id }),
              index: 0,
            },
          ],
        },
      },
    ],
  };
}

class StreamSocket implements RealtimeSocket {
  readonly messages = new Array<string>();

  close(code?: number): void {
    if (code !== undefined) {
      this.messages.unshift(String(code));
    }
  }

  send(message: string): number {
    const before = this.messages.length;
    this.messages.splice(before, 0, message);
    return message.length;
  }
}

function createPublisher(
  hub: RealtimeHub,
  userId: string,
  streamId: string,
): ToolStreamPublisher {
  return new ToolStreamPublisher({
    hub,
    sessionId: SESSION_ID,
    streamId,
    userId,
  });
}

function connectPublisher(
  userId: string,
  streamId: string,
): {
  readonly hub: RealtimeHub;
  readonly publisher: ToolStreamPublisher;
  readonly socket: StreamSocket;
} {
  const hub = new RealtimeHub();
  const socket = new StreamSocket();
  hub.setUser(userId, socket, true);
  return { hub, publisher: createPublisher(hub, userId, streamId), socket };
}

function decoded(socket: StreamSocket): readonly unknown[] {
  return socket.messages.map((message): unknown => JSON.parse(message));
}

function reconnectSnapshot(
  hub: RealtimeHub,
  userId: string,
  streamId: string,
): readonly unknown[] {
  const socket = new StreamSocket();
  hub.syncToolStreams(userId, SESSION_ID, streamId, socket);
  return decoded(socket);
}

test("starts every model turn with an independent stream identity", () => {
  const streamIds: string[] = [];
  const detail: AgentSessionDetail = Object.assign(
    {
      agentFile: null,
      activeDurationMs: 0,
      activeStartedAt: null,
      autoCompact: true,
      costBasis: "none" as const,
      costUsd: 0,
      createdAt: 1,
      credentialId: "credential-1",
      currentContextTokens: 0,
    },
    {
      id: SESSION_ID,
      maxContextTokens: null,
      messages: [],
      model: "test-model",
      provider: "openai" as const,
      providerPricing: null,
      reasoningEffort: null,
      runnerId: RUNNER_ID,
      status: "running" as const,
      title: "Streaming",
      tools: [],
      updatedAt: 1,
      workingDirectory: ".",
    },
  );
  const models = createSessionAgentModels({
    agentFile: null,
    credential: {
      accountId: null,
      id: "credential-1",
      isDefault: true,
      label: "Test",
      secret: "secret",
      source: "api_key",
    },
    detail,
    factory: (options) => ({
      complete: () => Promise.reject(new Error("unused")),
      ...(options.onTurnStart === undefined
        ? {}
        : { startTurn: options.onTurnStart }),
    }),
    id: (() => {
      const ids = ["initial", "turn-a", "turn-b"];
      return () => ids.shift() ?? "exhausted";
    })(),
    realtime: undefined,
    toolStream: {
      provider: () => undefined,
      reset: () => undefined,
      startTurn: (streamId) => streamIds.push(streamId),
    },
    userId: "user-turns",
  });
  models.agent.startTurn?.();
  models.agent.startTurn?.();

  expect(streamIds).toEqual(["turn-a", "turn-b"]);
});

test("accumulates and exposes partial provider tool calls", () => {
  const deltas: unknown[] = [];
  const chat = createProviderStreamAccumulator("chat_completions", (delta) => {
    deltas.push(delta);
  });
  chat.push(
    chatToolChunk({ arguments: '{"path":', id: "call-chat", name: "re" }),
  );
  chat.push(chatToolChunk({ arguments: '"README.md"}', name: "ad" }));

  expect(deltas).toMatchObject([
    {
      toolCall: {
        arguments: '{"path":',
        id: "call-chat",
        index: 0,
        name: "re",
      },
    },
    {
      toolCall: {
        arguments: '"README.md"}',
        id: "",
        index: 0,
        name: "ad",
      },
    },
  ]);
  expect(chat.finish().toolCalls).toEqual([
    {
      arguments: '{"path":"README.md"}',
      id: "call-chat",
      name: "read",
    },
  ]);

  const responses = createProviderStreamAccumulator("responses", (delta) => {
    deltas.push(delta);
  });
  responses.push({
    item: {
      arguments: "",
      call_id: "call-response",
      name: "bash",
      type: "function_call",
    },
    output_index: 2,
    type: "response.output_item.added",
  });
  responses.push({
    delta: '{"command":"pwd"}',
    output_index: 2,
    type: "response.function_call_arguments.delta",
  });
  responses.push({ response: { output: [] }, type: "response.completed" });
  expect(responses.finish().toolCalls[0]).toEqual({
    arguments: '{"command":"pwd"}',
    id: "call-response",
    name: "bash",
  });
});

test("announces a malformed call and its one canonical error result", async () => {
  const call = { arguments: "{broken", id: "bad-call", name: "read" };
  const lifecycle: unknown[] = [];
  const recorded: { readonly role: string }[] = [];
  await runAgentLoop({
    executeTool: () => Promise.reject(new Error("must not execute")),
    initialMessages: [{ content: "Read", role: "user" }],
    model: new ScriptedAgentModel([
      { content: "", toolCalls: [call] },
      { content: "Recovered", toolCalls: [] },
    ]),
    onToolCall: (started) => {
      lifecycle.unshift({ started });
    },
    onToolResult: (completed, outcome) => {
      lifecycle.splice(lifecycle.length, 0, { completed, outcome });
    },
    recordMessage: (message) => {
      recorded.splice(recorded.length, 0, message);
    },
  });

  expect(lifecycle).toEqual([
    { started: call },
    {
      completed: call,
      outcome: {
        output: "Error: the tool arguments were not a JSON object.",
        state: "failed",
      },
    },
  ]);
  expect(recorded.filter(({ role }) => role === "tool")).toHaveLength(1);
});

test("marks caught session-tool errors as failed", async () => {
  const result = await executeSessionAgentTool(
    {
      continueSession: () => Promise.resolve("continued"),
      listSessions: () => "listed",
      readSession: () => "read",
      sendToSession: () => Promise.resolve("sent"),
      spawnSession: () => Promise.resolve("spawned"),
      stopSession: () => "stopped",
    },
    "list_sessions",
    { unexpected: true },
  );

  expect(result).toEqual({
    output: "Error: list_sessions does not accept arguments",
    state: "failed",
  });
});

test("orders runner output and rejects gaps and late deltas", async () => {
  const streamed = new Set<unknown>();
  const broker = new RunnerCommandBroker({
    commandId: () => ["command", "stream"].join("-"),
  });
  const result = broker.dispatch(runnerCommand(), undefined, (delta) => {
    streamed.add(delta);
  });
  broker.take(RUNNER_ID);
  expect(
    broker.stream(RUNNER_ID, "command-stream", {
      channel: "stdout",
      content: "one",
      sequence: 0,
    }),
  ).toBe(true);
  expect(
    broker.stream(RUNNER_ID, "command-stream", {
      channel: "stderr",
      content: "gap",
      sequence: 2,
    }),
  ).toBe(false);
  expect(
    broker.stream(RUNNER_ID, "command-stream", {
      channel: "stderr",
      content: "two",
      sequence: 1,
    }),
  ).toBe(true);
  broker.complete(RUNNER_ID, "command-stream", {
    output: "done",
    state: "completed",
  });
  expect(
    broker.stream(RUNNER_ID, "command-stream", {
      channel: "stdout",
      content: "late",
      sequence: 2,
    }),
  ).toBe(false);
  expect(streamed.size).toBe(2);
  expect(await result).toEqual({ output: "done", state: "completed" });
});

test("publishes a complete name when provider fragments were unavailable", async () => {
  const { hub, publisher, socket } = connectPublisher(
    "user-nonstreaming",
    "turn-nonstreaming",
  );
  publisher.running("call-nonstreaming", "bash");
  await Promise.resolve();

  expect(decoded(socket).map((event) => JSON.stringify(event))).toEqual([
    expect.stringContaining('"sequence":0'),
    expect.stringContaining('"content":"bash"'),
    expect.stringContaining('"state":"running"'),
  ]);
  expect(
    reconnectSnapshot(hub, "user-nonstreaming", "turn-nonstreaming")[0],
  ).toMatchObject({
    streams: [expect.objectContaining({ name: "bash", state: "running" })],
  });
});

test("publishes sequenced bounded lifecycle events and a reconnect snapshot", async () => {
  const hub = new RealtimeHub();
  const live = new StreamSocket();
  hub.setUser("user-1", live, true);
  const publisher = createPublisher(hub, "user-1", "turn-1");
  publisher.provider({
    arguments: '{"command":',
    id: "call-1",
    index: 0,
    name: "ba",
  });
  publisher.provider({
    arguments: '"pwd"}',
    id: "",
    index: 0,
    name: "sh",
  });
  publisher.running("call-1", "bash");
  publisher.output("call-1", "stdout", "/work\n");
  await Promise.resolve();

  const liveEvents = decoded(live);
  expect(liveEvents).toMatchObject([
    { sequence: 0, state: "preparing" },
    { channel: "name", sequence: 1 },
    { channel: "arguments", sequence: 2 },
    { channel: "name", sequence: 3 },
    { channel: "arguments", sequence: 4 },
    { sequence: 5, state: "running" },
    { channel: "stdout", sequence: 6 },
  ]);

  expect(reconnectSnapshot(hub, "user-1", "turn-1")[0]).toMatchObject({
    streams: [
      {
        arguments: '{"command":"pwd"}',
        callId: "call-1",
        name: "bash",
        sequence: 6,
        stdout: "/work\n",
      },
    ],
    type: "tool_stream_snapshot",
  });

  publisher.completed("call-1");
  publisher.output("call-1", "stderr", "late");
  await Promise.resolve();
  await Promise.resolve();
  expect(decoded(live).at(-1)).toMatchObject({ state: "completed" });
  const afterTerminal = reconnectSnapshot(hub, "user-1", "turn-1")[0];
  expect(Reflect.get(afterTerminal ?? {}, "streams")).toEqual([]);
});

test("reconciles a provider placeholder with the final call ID", async () => {
  const { publisher, socket } = connectPublisher(
    "user-placeholder",
    "turn-placeholder",
  );
  publisher.provider({ arguments: "{", id: "", index: 0, name: "re" });
  publisher.provider({
    arguments: "}",
    id: "call-final",
    index: 0,
    name: "ad",
  });
  await Promise.resolve();

  expect(decoded(socket)).toContainEqual(
    expect.objectContaining({
      callId: "call-final",
      previousCallId: `pending:turn-placeholder:0`,
      sequence: 3,
    }),
  );
});

test("cancels retry streams and ignores events after failure", async () => {
  const { publisher, socket } = connectPublisher("user-retry", "turn-2");
  publisher.provider({ arguments: "{", id: "retry", index: 0, name: "read" });
  publisher.reset("turn-2-retry");
  publisher.provider({ arguments: "{}", id: "final", index: 0, name: "read" });
  publisher.close("failed");
  publisher.completed("final");
  await Promise.resolve();

  const events = decoded(socket);
  expect(
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        Reflect.get(event, "callId") === "retry" &&
        Reflect.get(event, "state") === "canceled",
    ),
  ).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({
      callId: "final",
      sequence: 0,
      state: "preparing",
    }),
  );
  expect(events.at(-1)).toEqual(
    expect.objectContaining({ callId: "final", state: "failed" }),
  );
});

test("keeps model turns with reused provider indexes independently sequenced", async () => {
  const { hub, publisher, socket } = connectPublisher(
    "user-turns",
    "session-run",
  );

  publisher.startTurn("turn-a");
  publisher.provider({ arguments: "{}", id: "call-a", index: 0, name: "read" });
  publisher.completed("call-a");
  publisher.startTurn("turn-b");
  publisher.provider({ arguments: "{}", id: "call-b", index: 0, name: "read" });
  await Promise.resolve();

  const starts = decoded(socket).filter((event) => {
    if (typeof event !== "object" || event === null) {
      return false;
    }
    return Reflect.get(event, "state") === "preparing";
  });
  expect(starts).toMatchObject([
    { callId: "call-a", sequence: 0, streamId: "turn-a" },
    { callId: "call-b", sequence: 0, streamId: "turn-b" },
  ]);

  expect(reconnectSnapshot(hub, "user-turns", "turn-b")[0]).toMatchObject({
    streams: [expect.objectContaining({ callId: "call-b" })],
  });
});
