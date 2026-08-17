import { expect, test, vi } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import {
  RUNNER_DIRECTORY_COMMAND,
  type RunnerDirectoryListing,
} from "../../shared/runner-directory-model.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { SessionAgentActions } from "../../sync-engine/session-agent-actions.ts";
import { loadSessionAgentFile } from "../../sync-engine/session-agent-file.ts";
import {
  SessionRequestHelpers,
  type RunnerDirectoryRequest,
} from "../../sync-engine/session-request-helpers.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createAuthenticatedTestContext,
  createAuthenticatedTestDatabase,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  EMPTY_SESSION_REQUEST_MODEL_METADATA,
  inactiveSessionAgentActionDefaults,
} from "./session-race-test-helpers.ts";

const RUNNER_ID = "runner-filesystem";
const SESSION_ID = "session-filesystem";
const WORKING_DIRECTORY = "/work/project";

function testSession(): AgentSessionDetail {
  return {
    ...TEST_SESSION_DETAIL,
    activeStartedAt: Date.now(),
    createdAt: Date.now(),
    credentialId: "credential-filesystem",
    currentContextTokens: 0,
    generation: 3,
    id: SESSION_ID,
    maxContextTokens: null,
    model: "gpt-4.1-mini",
    runnerId: RUNNER_ID,
    status: "running",
    title: "Filesystem command",
    tools: [],
    updatedAt: Date.now(),
    workingDirectory: WORKING_DIRECTORY,
  };
}

class CurrentSessionStore extends SessionStore {
  override get(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined {
    const session = testSession();
    return userId === TEST_USER_ID && sessionId === session.id
      ? session
      : undefined;
  }

  override executionIsCurrent(
    userId: string,
    sessionId: string,
    generation: number,
  ): boolean {
    const session = testSession();
    return (
      userId === TEST_USER_ID &&
      sessionId === session.id &&
      generation === session.generation
    );
  }
}

function queuedBroker() {
  let nextId = 0;
  return new RunnerCommandBroker({
    commandId: () => `filesystem-command-${String((nextId += 1))}`,
  });
}

function directoryRequest(authorize: () => boolean): RunnerDirectoryRequest {
  return {
    authorize,
    path: WORKING_DIRECTORY,
    runnerId: RUNNER_ID,
    sessionId: SESSION_ID,
    userId: TEST_USER_ID,
  };
}

function helpers(broker: RunnerCommandBroker) {
  const { auth, database } = createAuthenticatedTestContext();
  const close = () => {
    database.$client.close();
  };
  return {
    close,
    requests: new SessionRequestHelpers(auth, broker, {
      runnerIsAvailable: () => true,
    }),
  };
}

function expectAgentFileAbort(result: Promise<unknown>): Promise<void> {
  return expect(result).rejects.toMatchObject({ name: "AbortError" });
}

function testAgentFile(
  broker: RunnerCommandBroker,
  authorize: () => boolean,
  signal = new AbortController().signal,
) {
  return loadSessionAgentFile(broker, testSession(), signal, authorize);
}

function browseDirectory(
  requests: SessionRequestHelpers,
  authorize: () => boolean,
): ReturnType<SessionRequestHelpers["browseDirectories"]> {
  return requests.browseDirectories(
    directoryRequest(authorize),
    new AbortController().signal,
  );
}

function authorityLossSetup(kind: "agent-file" | "directory") {
  const broker = queuedBroker();
  const directory = kind === "directory" ? helpers(broker) : undefined;
  let authorized = true;
  const result =
    directory === undefined
      ? testAgentFile(broker, () => authorized)
      : browseDirectory(directory.requests, () => authorized);
  return {
    broker,
    revoke: () => {
      authorized = false;
    },
    verify: async () => {
      if (directory === undefined) {
        await expectAgentFileAbort(result);
      } else {
        await expect(result).resolves.toEqual({
          status: "directory_unavailable",
        });
        directory.close();
      }
    },
  };
}

test.each(["agent-file", "directory"] as const)(
  "rejects a queued %s command after execution authority is lost",
  async (kind) => {
    const setup = authorityLossSetup(kind);

    setup.revoke();

    expect(setup.broker.take(RUNNER_ID)).toBeUndefined();
    await setup.verify();
  },
);

test("passes a custom agent file path to the runner", async () => {
  const broker = queuedBroker();
  const result = loadSessionAgentFile(
    broker,
    { ...testSession(), agentFilePath: "config/instructions.md" },
    new AbortController().signal,
    () => true,
  );
  const command = broker.take(RUNNER_ID);

  expect(command?.arguments).toEqual({
    path: "config/instructions.md",
  });
  if (command !== undefined) {
    broker.complete(RUNNER_ID, command.id, {
      output: JSON.stringify(null),
      state: "completed",
    });
  }
  await expect(result).resolves.toBeNull();
});

test("cancellation uses the parent session identity for agent-file and directory commands", async () => {
  const broker = queuedBroker();
  const setup = helpers(broker);
  const signal = new AbortController().signal;
  const agentFile = testAgentFile(broker, () => true, signal);
  const directory = browseDirectory(setup.requests, () => true);

  const canceled = broker.cancelSessionCommands(SESSION_ID);

  expect(canceled.map(({ sessionId, tool }) => ({ sessionId, tool }))).toEqual([
    { sessionId: SESSION_ID, tool: RUNNER_AGENT_FILE_COMMAND },
    { sessionId: SESSION_ID, tool: RUNNER_DIRECTORY_COMMAND },
  ]);
  await expectAgentFileAbort(agentFile);
  await expect(directory).resolves.toEqual({ status: "directory_unavailable" });
  setup.close();
});

function actionDefaults() {
  return {
    ...inactiveSessionAgentActionDefaults(),
    notify: () => undefined,
  };
}

test("agent directory browsing passes parent identity, authorization, and signal", async () => {
  const signal = new AbortController().signal;
  const browse = vi.fn(
    (request: RunnerDirectoryRequest, receivedSignal: AbortSignal) => {
      expect({
        authorized: request.authorize?.(),
        sessionId: request.sessionId,
        signal: receivedSignal,
      }).toEqual({ authorized: true, sessionId: SESSION_ID, signal });
      const listing: RunnerDirectoryListing = {
        directories: [],
        parent: null,
        path: WORKING_DIRECTORY,
        truncated: false,
      };
      return Promise.resolve({ listing, status: "listed" as const });
    },
  );
  const database = createAuthenticatedTestDatabase();
  const store = new CurrentSessionStore(database);
  const session = testSession();
  const actions = new SessionAgentActions({
    ...actionDefaults(),
    browseDirectories: browse,
    database,
    discoverSessionMetadata: () =>
      Promise.resolve(EMPTY_SESSION_REQUEST_MODEL_METADATA),
    draining: () => false,
    launchSession: () => true,
    listOnlineRunners: () => [
      {
        architecture: "x64",
        createdAt: 0,
        id: RUNNER_ID,
        isDefault: true,
        lastSeenAt: 0,
        machineFingerprint: "machine",
        name: "runner",
        platform: "linux",
        status: "online",
        updatedAt: 0,
      },
    ],
    now: () => 0,
    readCredential: () => Promise.resolve(undefined),
    store,
    withCredential: () => Promise.resolve(new Response()),
  }).actions(session.id, TEST_USER_ID, session.generation, signal);

  await expect(
    actions.browseRunnerDirectories(RUNNER_ID, WORKING_DIRECTORY),
  ).resolves.toContain(`"path": "${WORKING_DIRECTORY}"`);
  expect(browse).toHaveBeenCalledOnce();
  database.$client.close();
});
