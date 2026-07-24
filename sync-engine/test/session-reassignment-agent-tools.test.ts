import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { createdAuditFields } from "../../shared/audit.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { runners, users } from "../../shared/database/schema.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createAuthenticatedRequest,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeToolSession,
  findToolResultContent,
  isToolResult,
} from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSessionSetup,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
  REPLACEMENT_RUNNER_ID,
} from "./session-integration-fixtures.ts";
import {
  directoryListing,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { requireCreatedSession } from "./session-store-result-helpers.ts";

const FOREIGN_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000082";
const RECOVERABLE_SESSION_ID = "018bcfe5-6800-7000-8000-000000000084";
const RECOVERABLE_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000085";
const REMOVED_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000083";

type SessionToolSetup = ReturnType<typeof connectedSessionSetup>;

function insertConnectedRunner(
  setup: SessionToolSetup,
  options: {
    readonly id: string;
    readonly machineFingerprint: string;
    readonly name: string;
    readonly token: string;
    readonly userId: string;
  },
): void {
  setup.database
    .insert(runners)
    .values({
      ...createdAuditFields(options.userId, TEST_NOW),
      architecture: "x64",
      id: options.id,
      lastSeenAt: new Date(TEST_NOW),
      machineFingerprint: options.machineFingerprint,
      name: options.name,
      platform: "linux",
      tokenHash: createHash("sha256").update(options.token).digest("base64url"),
      userId: options.userId,
    })
    .run();
}

function addReplacementRunner(setup: SessionToolSetup): void {
  setup.runners.collection(
    createAuthenticatedRequest("/api/runners", undefined, "POST"),
  );
  expect(
    setup.runners.connect("qmr_replacement-runner-token", {
      architecture: "arm64",
      machineFingerprint: "replacement-agent-tool-machine",
      name: "replacement",
      platform: "linux",
    })?.connection.id,
  ).toBe(REPLACEMENT_RUNNER_ID);
}

function addForeignRunner(setup: SessionToolSetup, runnerId: string): void {
  const foreignUserId = "018bcfe5-6800-7000-8000-000000000081";
  setup.database
    .insert(users)
    .values({
      ...createdAuditFields(foreignUserId, TEST_NOW),
      email: "foreign@example.com",
      googleSubject: "foreign-google-user",
      id: foreignUserId,
      name: "Foreign User",
    })
    .run();
  insertConnectedRunner(setup, {
    id: runnerId,
    machineFingerprint: "foreign-agent-tool-machine",
    name: "foreign",
    token: "foreign-runner-token",
    userId: foreignUserId,
  });
}

function findToolResultContents(value: unknown, name: string): string[] {
  const messagesValue = isRecord(value) ? value["messages"] : undefined;
  if (!Array.isArray(messagesValue)) {
    return [];
  }
  return messagesValue.flatMap((message: unknown) =>
    isToolResult(message, name) ? [message.content] : [],
  );
}

function createRecoverableSession(setup: SessionToolSetup): void {
  insertConnectedRunner(setup, {
    id: REMOVED_RUNNER_ID,
    machineFingerprint: "removed-agent-tool-machine",
    name: "removed",
    token: "removed-runner-token",
    userId: TEST_USER_ID,
  });
  const generatedIds = [RECOVERABLE_SESSION_ID, RECOVERABLE_MESSAGE_ID];
  const store = new SessionStore(setup.database, () => {
    const id = generatedIds.shift();
    if (id === undefined) {
      throw new Error("The test ran out of recoverable session IDs");
    }
    return id;
  });
  const created = store.create(
    {
      autoCompact: true,
      credentialId: CREDENTIAL_ID,
      images: [],
      maxContextTokens: null,
      model: "gpt-4.1-mini",
      prompt: "Recover this session",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: "high",
      runnerId: REMOVED_RUNNER_ID,
      tools: AGENT_SESSION_TOOL_NAMES,
      userId: TEST_USER_ID,
      workingDirectory: "/old/project",
    },
    TEST_NOW,
  );
  const recoverable = requireCreatedSession(created);
  expect(store.mark(recoverable.id, "running", TEST_NOW + 1)).toBe(true);
  expect(store.mark(recoverable.id, "idle", TEST_NOW + 2)).toBe(true);
}

async function startAgent(setup: SessionToolSetup): Promise<void> {
  await startToolSessionSetup(setup);
}

describe("runner reassignment agent tools", () => {
  test("lists recoverable sessions and reassigns without launching", async () => {
    const model = scriptedModel([
      {
        content: "Inspecting recoverable sessions.",
        toolCalls: [toolCall("list_sessions", {})],
      },
      {
        content: "Checking replacement runners.",
        toolCalls: [toolCall("list_runners", {})],
      },
      {
        content: "Reassigning the recoverable session.",
        toolCalls: [
          toolCall("reassign_session", {
            runnerId: REPLACEMENT_RUNNER_ID,
            sessionId: RECOVERABLE_SESSION_ID,
            workingDirectory: "/home/mush/projects/q-mush",
          }),
        ],
      },
      { content: "Reassignment complete.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model);
    createRecoverableSession(setup);
    addReplacementRunner(setup);
    addForeignRunner(setup, FOREIGN_RUNNER_ID);
    await setup.runners.remove(
      createAuthenticatedRequest(
        `/api/runners/${REMOVED_RUNNER_ID}`,
        undefined,
        "DELETE",
      ),
      REMOVED_RUNNER_ID,
    );
    await startAgent(setup);

    const detail = await completedParentDetail(setup, "idle");
    const listedSessions = findToolResultContent(detail, "list_sessions");
    const listedRunners = findToolResultContent(detail, "list_runners");
    expect(listedSessions).toContain(RECOVERABLE_SESSION_ID);
    expect(listedSessions).toContain('"runnerRequired": true');
    expect(listedRunners).toContain(REPLACEMENT_RUNNER_ID);
    expect(listedRunners).not.toContain(REMOVED_RUNNER_ID);
    expect(listedRunners).not.toContain(FOREIGN_RUNNER_ID);
    expect(listedRunners).not.toContain("tokenHash");
    expect(findToolResultContent(detail, "reassign_session")).toContain(
      '"status": "reassigned"',
    );
    expect(
      setup.sessions.detailForUser(TEST_USER_ID, RECOVERABLE_SESSION_ID),
    ).toEqual(
      expect.objectContaining({
        runnerId: REPLACEMENT_RUNNER_ID,
        runnerRequired: false,
        status: "idle",
        workingDirectory: "/home/mush/projects/q-mush",
      }),
    );
    closeToolSession(setup);
  });

  test("browses only an owned online runner and returns canonical paths", async () => {
    const model = scriptedModel([
      {
        content: "Trying a foreign runner.",
        toolCalls: [
          toolCall("browse_runner_directories", {
            path: "~",
            runnerId: FOREIGN_RUNNER_ID,
          }),
        ],
      },
      {
        content: "Browsing my replacement runner.",
        toolCalls: [
          toolCall("browse_runner_directories", {
            path: "~",
            runnerId: REPLACEMENT_RUNNER_ID,
          }),
        ],
      },
      { content: "Directory selected.", toolCalls: [] },
    ]);
    let nextCommand = 0;
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      commandId: () => `agent-command-${String((nextCommand += 1))}`,
    });
    addReplacementRunner(setup);
    addForeignRunner(setup, FOREIGN_RUNNER_ID);
    await startAgent(setup);

    const directoryCommand = await waitForSessionValue(
      () => setup.runnerCommands.at(-1),
      (value) =>
        isRecord(value) &&
        value["tool"] === "list_directories" &&
        value["workingDirectory"] === "~",
    );
    if (
      !isRecord(directoryCommand) ||
      typeof directoryCommand["id"] !== "string"
    ) {
      throw new Error("The directory command ID is unavailable");
    }
    expect(
      setup.sessions.completeRunnerCommand(
        REPLACEMENT_RUNNER_ID,
        directoryCommand["id"],
        JSON.stringify(directoryListing()),
      ),
    ).toBe(true);

    const detail = await completedParentDetail(setup, "idle");
    const browseResults = findToolResultContents(
      detail,
      "browse_runner_directories",
    );
    expect(browseResults).toHaveLength(2);
    expect(browseResults[0]).toContain("runner_unavailable");
    expect(browseResults[1]).toContain("/home/mush/projects/q-mush");
    expect(browseResults.join(" ")).not.toContain("tokenHash");
    setup.database.$client.close();
  });
});
