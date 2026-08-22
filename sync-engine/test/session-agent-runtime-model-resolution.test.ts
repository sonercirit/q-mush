import { describe, expect, test } from "vitest";
import type { AgentModelRequestOptions } from "../agent-model-options.ts";
import { ChatCompletionsAgentModel } from "../agent-model.ts";
import { runSessionAgent } from "../session-agent-runtime.ts";
import {
  ANTHROPIC_TEST_CREDENTIAL,
  KNOWN_ANTHROPIC_MODEL,
  thinkingReplayBlock,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import { anthropicJsonResponse } from "./anthropic-response-event-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  completingTestBroker,
  IDLE_RUNTIME_SIGNALS,
} from "./session-agent-runtime-test-helpers.ts";
import { unusedSessionToolActions } from "./session-agent-tool-test-helpers.ts";
import {
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const REQUEST_ALIAS = "claude-current";
const TOOL_CALL = {
  arguments: "{}",
  id: "read-call",
  name: "list_sessions",
} as const;

function clientToolResponse(): Response {
  return anthropicJsonResponse({
    blocks: [
      thinkingReplayBlock("runtime-retry-signature"),
      toolReplayBlock({ id: TOOL_CALL.id, input: {}, name: TOOL_CALL.name }),
    ],
    model: KNOWN_ANTHROPIC_MODEL,
  });
}

describe("session Anthropic model resolution", () => {
  test("retries a transient startup resolution on a later completion in the same run", async () => {
    const setup = runningCompactionStore();
    const stored = requireCompactionSession(setup.store);
    const detail = {
      ...stored,
      credentialId: ANTHROPIC_TEST_CREDENTIAL.id,
      model: REQUEST_ALIAS,
      provider: "generic" as const,
      tools: ["list_sessions" as const],
    };
    const retrievals: Request[] = [];
    const completions: Request[] = [];
    const responses = [
      clientToolResponse(),
      anthropicJsonResponse({ blocks: [{ text: "Recovered.", type: "text" }] }),
    ];
    const modelFactory = (options: AgentModelRequestOptions) =>
      new ChatCompletionsAgentModel({
        ...options,
        fetch: (request) => {
          if (request.method === "GET") {
            retrievals.push(request);
            return retrievals.length === 1
              ? Promise.reject(new TypeError("temporary retrieval failure"))
              : Promise.resolve(Response.json({ id: KNOWN_ANTHROPIC_MODEL }));
          }
          completions.push(request);
          const response = responses.shift();
          if (response === undefined) {
            throw new Error("No completion response remains");
          }
          return Promise.resolve(response);
        },
      });
    let now = TEST_NOW + 2;

    await expect(
      runSessionAgent({
        braveSearch: { execute: () => Promise.resolve("unused search") },
        broker: completingTestBroker(),
        credential: {
          ...ANTHROPIC_TEST_CREDENTIAL,
          isDefault: true,
          label: "Anthropic test",
        },
        detail,
        ...IDLE_RUNTIME_SIGNALS,
        isCurrent: () => true,
        modelFactory,
        modelFetch: (request) => {
          retrievals.push(request);
          return Promise.reject(new TypeError("temporary retrieval failure"));
        },
        now: () => (now += 1),
        pendingComponent: () => undefined,
        sessionTools: unusedSessionToolActions({
          listSessions: () => "session list",
        }),
        signal: new AbortController().signal,
        store: setup.store,
        userId: TEST_USER_ID,
      }),
    ).resolves.toBe("complete");

    expect(retrievals).toHaveLength(2);
    expect(completions).toHaveLength(2);
    closeSessionTestDatabase(setup.database);
  });
});
