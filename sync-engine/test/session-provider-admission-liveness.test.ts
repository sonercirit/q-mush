import { join } from "node:path";
import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import type { AgentModelRequestOptions } from "../../sync-engine/agent-model-options.ts";
import {
  createChatCompletionsAgentModel,
  type ChatCompletionsAgentModel,
} from "../../sync-engine/agent-model.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_AUTHENTICATED_USER,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { DeferredAgentModel } from "./deferred-agent-model.ts";
import {
  createFakeProviderSockets,
  expectProviderSocketReleased,
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
  createSessionRequest,
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
const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-provider-admission-",
);

class StalledReusedSocketModel implements AgentModel {
  readonly #model: ChatCompletionsAgentModel;
  readonly requests: AgentConversationMessage[][] = [];
  readonly sockets = createFakeProviderSockets();

  constructor(
    onDelta: AgentModelRequestOptions["onDelta"],
    onRequestState: AgentModelRequestOptions["onRequestState"],
  ) {
    this.#model = createChatCompletionsAgentModel({
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
      toolSettings: DEFAULT_TOOL_SETTINGS,
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

async function createStalledSession(
  executionEnvironment: "bare_metal" | "container" = "bare_metal",
  database?: ReturnType<typeof createAuthenticatedTestDatabase>,
) {
  const clock = testLivenessClock(1_000, 100, true);
  let model: StalledReusedSocketModel | undefined;
  const setup = connectedSessionSetup(
    new DeferredAgentModel(),
    "api_key",
    undefined,
    {
      ...(database === undefined ? {} : { database }),
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
  await startToolSessionSetup(
    setup,
    null,
    createSessionRequest(
      true,
      "high",
      "gpt-4.1-mini",
      [],
      undefined,
      undefined,
      undefined,
      executionEnvironment,
    ),
    executionEnvironment,
  );
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
    response: { id: "response-tool", output: [call] },
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
  const run = await createStalledSession("container");
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
  socket.receive({ type: "provider.keepalive" });
  socket.receive({
    response: { id: "response-tool", output: [] },
    type: "response.completed",
  });
  expect(currentDetail(run)?.runtimePending).toMatchObject({
    component: "provider_admission",
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
  if (!isRecord(failed)) throw new TypeError("Expected failed session detail");
  const messages = failed["messages"];
  const lastMessage: unknown = Array.isArray(messages)
    ? messages.at(-1)
    : undefined;
  expect(lastMessage).toMatchObject({
    content:
      "Session failed: the provider request was not acknowledged during the liveness recovery window",
  });
  await waitForSessionValue(
    () => hasRealtimeSession(browser.record.sent, isFailedTerminalEvent),
    (published) => published === true,
  );
  expectProviderSocketReleased(socket);
  await waitForSessionValue(
    () => run.setup.cleanupCommands.length,
    (count) => count === 1,
  );
  expect(run.setup.cleanupCommands[0]).toMatchObject({
    executionEnvironment: "container",
    sessionId: SESSION_ID,
    tool: RUNNER_EXECUTION_CLEANUP_COMMAND,
  });
  expectDurableToolOnce(run);
  expect(run.model.requests).toHaveLength(2);
  expectToolReplay(run.model, 1);

  closeRealtimeSocket(realtime.websocket, browser.socket);
  closeLivenessSession(run.setup);
});

test("process recreation fails the running row without replaying durable tools", async () => {
  const databasePath = join(temporaryDirectory(), "sessions.sqlite");
  const database = createAuthenticatedTestDatabase({
    expiresAt: TEST_NOW + 7 * 24 * 60 * 60 * 1_000,
    path: databasePath,
  });
  const run = await createStalledSession("bare_metal", database);
  const { socket } = await completeDurableTool(run);
  expect(sessionStatus(run.setup.sessions)).toBe("running");

  run.model.sockets.created[0]?.close(1000, "Process terminated");
  expectProviderSocketReleased(socket);
  closeLivenessSession(run.setup);

  const reopened = createAuthenticatedTestDatabase({ path: databasePath });
  const resumedModel = new ScriptedAgentModel([
    { content: "Recovered from durable tool output.", toolCalls: [] },
  ]);
  const recreated = connectedSessionSetup(resumedModel, "api_key", undefined, {
    database: reopened,
  });
  await Bun.sleep(1);
  expect(sessionStatus(recreated.sessions)).toBe("failed");
  expect(resumedModel.requests).toHaveLength(0);
  expect(recreated.latestRunnerCommand()).toBeUndefined();
  expect(storedToolMessages(recreated.sessions)).toHaveLength(1);

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
