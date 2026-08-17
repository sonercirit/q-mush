import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  DEFAULT_LIST_SESSIONS_PAGE_SIZE,
  MAXIMUM_LIST_SESSIONS_PAGE_SIZE,
} from "../../sync-engine/session-agent-list.ts";
import {
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { jsonRecord, records } from "./session-agent-output-helpers.ts";
import {
  closeToolSession,
  findToolResultContents,
} from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  CREDENTIAL_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";

test("paginates, validates, and bounds session listings at dispatch", async () => {
  const listCalls = [
    {},
    { page: 2, pageSize: 2, search: "RUNNING" },
    { page: 99, pageSize: 2 },
    { search: "no matching session" },
    { page: null },
    { pageSize: null },
    { page: 1.5 },
    { page: 0 },
    { pageSize: MAXIMUM_LIST_SESSIONS_PAGE_SIZE + 1 },
    { unexpected: true },
  ];
  const model = scriptedModel([
    {
      content: "Inspect paginated session listings.",
      toolCalls: listCalls.map((arguments_, index) =>
        toolCall("list_sessions", arguments_, `list-${String(index)}`),
      ),
    },
    { content: "Pagination checked.", toolCalls: [] },
  ]);
  const setup = await startToolSession(model);
  setup.database
    .insert(agentSessions)
    .values(
      Array.from({ length: 24 }, (_, index) => ({
        ...testAuditFields(),
        executionEnvironment: "bare_metal" as const,
        id: `list-session-${String(index).padStart(2, "0")}`,
        model: "gpt-4.1-mini",
        provider: "openai" as const,
        providerCredentialId: CREDENTIAL_ID,
        runnerId: RUNNER_ID,
        status: index < 5 ? ("running" as const) : ("idle" as const),
        title: index === 2 ? "Needle Session" : `Session ${String(index)}`,
        tools: JSON.stringify(AGENT_SESSION_TOOL_NAMES),
        userId: TEST_USER_ID,
        workingDirectory: `/work/project-${String(index)}`,
        workspaceId: TEST_WORKSPACE_ID,
      })),
    )
    .run();
  const outputs = findToolResultContents(
    await completedParentDetail(setup, "idle"),
    "list_sessions",
  );
  const defaults = jsonRecord(outputs.at(0) ?? "null");
  const searched = jsonRecord(outputs.at(1) ?? "null");
  const outOfRange = jsonRecord(outputs.at(2) ?? "null");
  const missed = jsonRecord(outputs.at(3) ?? "null");

  expect(defaults).toMatchObject({
    hasNext: true,
    hasPrevious: false,
    page: 1,
    pageSize: DEFAULT_LIST_SESSIONS_PAGE_SIZE,
    totalItems: 25,
    totalPages: 2,
  });
  expect(records(defaults["items"])).toHaveLength(
    DEFAULT_LIST_SESSIONS_PAGE_SIZE,
  );
  expect(searched).toMatchObject({
    filters: { search: "RUNNING" },
    hasNext: true,
    hasPrevious: true,
    page: 2,
    pageSize: 2,
    totalItems: 6,
    totalPages: 3,
  });
  expect(records(searched["items"])).toHaveLength(2);
  expect(outOfRange).toMatchObject({
    hasNext: false,
    hasPrevious: true,
    page: 99,
    pageSize: 2,
    totalItems: 25,
    totalPages: 13,
  });
  expect(records(outOfRange["items"])).toEqual([]);
  expect(missed).toMatchObject({ totalItems: 0, totalPages: 0 });
  expect(records(missed["items"])).toEqual([]);
  expect(outputs).toHaveLength(listCalls.length);
  expect(
    outputs
      .slice(4)
      .every((output) =>
        output.includes("list_sessions arguments are invalid"),
      ),
  ).toBe(true);
  expect(Buffer.byteLength(outputs[0] ?? "", "utf8")).toBeLessThan(50 * 1_024);
  expect(outputs[0]).not.toContain("Output exceeds the per-call limit");
  closeToolSession(setup);

  const maximumText = "\u0000".repeat(100);
  const maximumOutputCharacters = 100_000;
  const maxModel = scriptedModel([
    {
      content: "Inspect the largest session-list page.",
      toolCalls: [
        toolCall("list_sessions", {
          pageSize: MAXIMUM_LIST_SESSIONS_PAGE_SIZE,
          search: maximumText,
        }),
      ],
    },
    { content: "Largest page checked.", toolCalls: [] },
  ]);
  const maxSetup = await startToolSession(maxModel, {
    toolSettings: {
      read: () => ({
        ...DEFAULT_TOOL_SETTINGS,
        outputLimitCharacters: maximumOutputCharacters,
      }),
    },
  });
  maxSetup.database
    .insert(agentSessions)
    .values(
      Array.from({ length: MAXIMUM_LIST_SESSIONS_PAGE_SIZE }, (_, index) => ({
        createdAt: new Date(index),
        createdById: TEST_USER_ID,
        executionEnvironment: "bare_metal" as const,
        id: `maximal-list-session-${String(index)}`,
        isDeleted: false,
        model: maximumText,
        parentSessionId: SESSION_ID,
        provider: "openrouter" as const,
        providerCredentialId: CREDENTIAL_ID,
        runnerId: RUNNER_ID,
        status: "completed" as const,
        title: maximumText,
        tools: JSON.stringify(AGENT_SESSION_TOOL_NAMES),
        updatedAt: new Date(index),
        updatedById: TEST_USER_ID,
        userId: TEST_USER_ID,
        workingDirectory: maximumText,
        workspaceId: TEST_WORKSPACE_ID,
      })),
    )
    .run();
  const [maxOutput] = findToolResultContents(
    await completedParentDetail(maxSetup, "idle"),
    "list_sessions",
  );

  expect(maxOutput).not.toContain("bounded session list output is too large");
  expect(records(jsonRecord(maxOutput ?? "null")["items"])).toHaveLength(
    MAXIMUM_LIST_SESSIONS_PAGE_SIZE,
  );
  expect(Buffer.byteLength(maxOutput ?? "", "utf8")).toBeLessThanOrEqual(
    maximumOutputCharacters,
  );
  closeToolSession(maxSetup);
});
