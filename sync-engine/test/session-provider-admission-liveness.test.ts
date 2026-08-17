import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import type { AgentModelRequestOptions } from "../../sync-engine/agent-model-options.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { DeferredAgentModel } from "./deferred-agent-model.ts";
import {
  expectProviderSocketReleased,
  FakeProviderSockets,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";
import { configuredRealtimeTestIntegration } from "./realtime-test-helpers.ts";
import {
  closeRealtimeSocket,
  openUserRealtimeTestSocket,
  parseRealtimeMessages,
} from "./realtime-test-socket-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { startToolSessionSetup } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import {
  closeLivenessSession,
  scanAfter,
  testLivenessClock,
} from "./session-liveness-test-helpers.ts";

const TOOL_CALL_ID = "call-terminal-bash";
const TOOL_OUTPUT = "terminal-result";

class StalledReusedSocketModel implements AgentModel {
  readonly #model: ChatCompletionsAgentModel;
  readonly requests: AgentConversationMessage[][] = [];
  readonly sockets = new FakeProviderSockets();

  constructor(
    onDelta: AgentModelRequestOptions["onDelta"],
    onRequestState: AgentModelRequestOptions["onRequestState"],
  ) {
    this.#model = new ChatCompletionsAgentModel({
      credential: {
        accountId: null,
        secret: "provider-secret",
        source: "api_key",
      },
      maxOutputTokens: null,
      model: "session-test-model",
      ...(onDelta === undefined ? {} : { onDelta }),
      ...(onRequestState === undefined ? {} : { onRequestState }),
      provider: "openai",
      webSocket: this.sockets.create,
    });
  }

  readonly close = (): void => {
    this.#model.close();
  };

  complete(
    messages: readonly AgentConversationMessage[],
    ...signals: readonly [AbortSignal?]
  ): Promise<AgentModelStep> {
    const [signal] = signals;
    this.requests.push(messages.map((message) => ({ ...message })));
    const model = this.#model;
    return model.complete(messages, signal);
  }
}

async function createStalledSession() {
  const clock = testLivenessClock(1_000, 100, true);
  let model: StalledReusedSocketModel | undefined;
  const setup = connectedSessionSetup(
    new DeferredAgentModel(),
    "api_key",
    undefined,
    {
      liveness: clock.dependencies,
      modelFactory: (options) => {
        model ??= new StalledReusedSocketModel(
          options.onDelta,
          options.onRequestState,
        );
        return model;
      },
      now: clock.now,
    },
  );
  await startToolSessionSetup(setup);
  await waitForSessionValue(
    () => model,
    (candidate) => candidate !== undefined,
  );
  if (model === undefined) {
    throw new Error("The stalled provider model was not created");
  }
  return { clock, model, setup };
}

async function emitToolCall(model: StalledReusedSocketModel): Promise<void> {
  await model.sockets.waitForAttempt(0);
  const socket = requireProviderSocket(model.sockets, 0);
  socket.open();
  socket.receive({
    response: { id: "response-tool" },
    type: "response.created",
  });
  const call = {
    arguments: JSON.stringify({ command: `echo ${TOOL_OUTPUT}` }),
    call_id: TOOL_CALL_ID,
    name: "bash",
    type: "function_call",
  };
  socket.receive({
    item: call,
    output_index: 0,
    type: "response.output_item.added",
  });
  socket.receive({
    response: { output: [call] },
    type: "response.completed",
  });
}

function isToolCommand(
  value: unknown,
  tool: string,
): value is RunnerToolCommand {
  return (
    isRecord(value) && value["tool"] === tool && typeof value["id"] === "string"
  );
}

function detailReachedProviderAdmission(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const pending = value["runtimePending"];
  const messages = value["messages"];
  if (!Array.isArray(messages)) return false;
  const containsDurableToolResult = messages.some((message) => {
    if (!isRecord(message)) return false;
    const output: unknown = message["content"];
    return message["role"] === "tool" && output === TOOL_OUTPUT;
  });
  return (
    isRecord(pending) &&
    pending["component"] === "provider_admission" &&
    containsDurableToolResult
  );
}

function currentDetail(run: Awaited<ReturnType<typeof createStalledSession>>) {
  return run.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
}

async function completeDurableTool(
  run: Awaited<ReturnType<typeof createStalledSession>>,
) {
  await emitToolCall(run.model);
  const command = await waitForSessionValue(
    run.setup.latestRunnerCommand,
    (candidate) => isToolCommand(candidate, "bash"),
  );
  if (!isToolCommand(command, "bash")) {
    throw new Error("The terminal bash command was unavailable");
  }
  expect(
    run.setup.sessions.completeRunnerCommand(RUNNER_ID, command.id, {
      output: TOOL_OUTPUT,
      state: "completed",
    }),
  ).toBe(true);
  const detail = await waitForSessionValue(
    () => currentDetail(run),
    (candidate) => candidate !== undefined,
  );
  await waitForSessionValue(
    () => currentDetail(run),
    detailReachedProviderAdmission,
  );
  return {
    detail: currentDetail(run) ?? detail,
    socket: requireProviderSocket(run.model.sockets, 0),
  };
}

function hasRealtimeSession(
  messages: readonly string[],
  predicate: (event: unknown) => boolean,
): boolean {
  return parseRealtimeMessages(messages).some(
    (event) =>
      isRecord(event) &&
      event["type"] === "session" &&
      predicate(event["session"]),
  );
}

function hasPendingAdmission(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const pending = event["runtimePending"];
  return isRecord(pending) && pending["component"] === "provider_admission";
}

function isFailedTerminalEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    event["status"] === "failed" &&
    event["runtimePending"] === null
  );
}

function sessionStatus(
  sessions: ReturnType<typeof connectedSessionSetup>["sessions"],
): string | undefined {
  return sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status;
}

function storedToolMessages(
  sessions: ReturnType<typeof connectedSessionSetup>["sessions"],
) {
  return sessions
    .detailForUser(TEST_USER_ID, SESSION_ID)
    ?.messages.filter((message) => message.toolCallId === TOOL_CALL_ID);
}

function expectToolReplay(
  model: Readonly<{ requests: readonly AgentConversationMessage[][] }>,
  requestIndex: number,
): void {
  expect(model.requests[requestIndex]).toContainEqual({
    content: TOOL_OUTPUT,
    role: "tool",
    toolCallId: TOOL_CALL_ID,
    toolName: "bash",
  });
}

function expectDurableToolOnce(
  run: Awaited<ReturnType<typeof createStalledSession>>,
): void {
  const messages = run.setup.sessions.detailForUser(
    TEST_USER_ID,
    SESSION_ID,
  )?.messages;
  expect(
    messages?.filter(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some(({ id }) => id === TOOL_CALL_ID),
    ),
  ).toHaveLength(1);
  expect(
    messages?.filter(
      (message) =>
        message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
    ),
  ).toHaveLength(1);
}

test("fails a reused provider socket that stalls after a durable tool result", async () => {
  const run = await createStalledSession();
  const realtime = configuredRealtimeTestIntegration({
    auth: {
      ...createGoogleAuthFromEnvironment(
        {},
        { database: run.setup.database, now: () => Date.now() },
      ),
      authenticatedUser: () => TEST_AUTHENTICATED_USER,
      revalidateUser: () => TEST_AUTHENTICATED_USER,
    },
    authRevalidationIntervalMs: 60_000,
    clearInterval: () => undefined,
    runners: run.setup.runners,
    sessions: run.setup.sessions,
    setInterval: () => 1,
    workspaceExists: (_userId, workspaceId) =>
      workspaceId === TEST_WORKSPACE_ID,
  });
  const browser = openUserRealtimeTestSocket(realtime, TEST_WORKSPACE_ID);

  const { detail, socket } = await completeDurableTool(run);
  expect(socket.sent).toHaveLength(2);
  expect(detail).toMatchObject({
    runtimePending: { component: "provider_admission", since: run.clock.now() },
    status: "running",
  });
  await waitForSessionValue(
    () => hasRealtimeSession(browser.record.sent, hasPendingAdmission),
    (published) => published === true,
  );

  scanAfter(run.clock, 1_000);

  const failed = await waitForSessionValue(
    () => currentDetail(run),
    hasSessionStatus("failed"),
  );
  expect(failed).toMatchObject({ runtimePending: null, status: "failed" });
  expect(JSON.stringify(failed)).toContain(
    "provider request was not acknowledged",
  );
  await waitForSessionValue(
    () => hasRealtimeSession(browser.record.sent, isFailedTerminalEvent),
    (published) => published === true,
  );
  expectProviderSocketReleased(socket);
  expectDurableToolOnce(run);
  expect(run.model.requests).toHaveLength(2);
  expectToolReplay(run.model, 1);

  closeRealtimeSocket(realtime.websocket, browser.socket);
  closeLivenessSession(run.setup);
});

test("recreation waits for explicit resume and does not duplicate durable tools", async () => {
  const run = await createStalledSession();
  await completeDurableTool(run);
  scanAfter(run.clock, 1_000);
  await waitForSessionValue(
    () => sessionStatus(run.setup.sessions),
    (status) => status === "failed",
  );

  const resumedModel = new ScriptedAgentModel([
    { content: "Recovered from durable tool output.", toolCalls: [] },
  ]);
  const recreated = connectedSessionSetup(resumedModel, "api_key", undefined, {
    database: run.setup.database,
  });
  await Bun.sleep(1);
  expect(resumedModel.requests).toHaveLength(0);
  expect(recreated.latestRunnerCommand()).toBeUndefined();

  const response = await recreated.sessions.continue(
    createAuthenticatedRequest(
      `/api/sessions/${SESSION_ID}/continue`,
      undefined,
      "POST",
    ),
    SESSION_ID,
  );
  expect(response.status).toBe(202);
  await completeAgentFileLookup(recreated);
  await waitForSessionValue(
    () => sessionStatus(recreated.sessions),
    (status) => status === "idle",
  );
  expect(resumedModel.requests).toHaveLength(1);
  expectToolReplay(resumedModel, 0);
  expect(storedToolMessages(recreated.sessions)).toHaveLength(1);
  closeLivenessSession(recreated);
});
