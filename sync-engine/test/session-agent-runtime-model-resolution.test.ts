import { describe, expect, test } from "vitest";
import {
  agentCredentialFingerprint,
  type AgentModelRequestOptions,
} from "../agent-model-options.ts";
import { ChatCompletionsAgentModel } from "../agent-model.ts";
import { anthropicReplayIdentityFrom } from "../anthropic-replay-identity.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "../session-agent-runtime.ts";
import {
  ANTHROPIC_TEST_CREDENTIAL,
  KNOWN_ANTHROPIC_MODEL,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import { anthropicJsonResponse } from "./anthropic-response-event-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
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
  const { provenance } = anthropicReplayIdentityFrom({
    credential: ANTHROPIC_TEST_CREDENTIAL,
    credentialFingerprint: agentCredentialFingerprint(
      ANTHROPIC_TEST_CREDENTIAL,
    ),
    model: REQUEST_ALIAS,
    provider: "generic",
    resolvedModel: KNOWN_ANTHROPIC_MODEL,
  });
  return anthropicJsonResponse({
    blocks: [
      toolReplayBlock({ id: TOOL_CALL.id, input: {}, name: TOOL_CALL.name }),
    ],
    model: KNOWN_ANTHROPIC_MODEL,
    provenance,
    requestModel: REQUEST_ALIAS,
  });
}

function runtimeDefaults() {
  return {
    broker: completingTestBroker(),
    braveSearch: { execute: () => Promise.resolve("unused search") },
    ...IDLE_RUNTIME_SIGNALS,
    isCurrent: () => true,
    pendingComponent: () => undefined,
    sessionTools: unusedSessionToolActions(),
    signal: new AbortController().signal,
    userId: TEST_USER_ID,
  };
}

describe("session Anthropic model resolution", () => {
  test.each([
    ["agent", runSessionAgent],
    ["compactor", compactSessionConversation],
  ] as const)(
    "retains matching persisted replay for the %s conversation",
    async (_label, execute) => {
      const setup = runningCompactionStore();
      const stored = requireCompactionSession(setup.store);
      const credential = {
        ...ANTHROPIC_TEST_CREDENTIAL,
        isDefault: true,
        label: "Anthropic test",
      };
      const detail = {
        ...stored,
        credentialId: credential.id,
        model: REQUEST_ALIAS,
        provider: "generic" as const,
      };
      const identity = anthropicReplayIdentityFrom({
        credential,
        credentialFingerprint: agentCredentialFingerprint(credential),
        model: REQUEST_ALIAS,
        provider: "generic",
        resolvedModel: KNOWN_ANTHROPIC_MODEL,
      });
      setup.store.appendCurrentAgentMessage(
        stored.id,
        {
          content: "Persisted answer",
          providerReplay: {
            blocks: [{ text: "Persisted answer", type: "text" }],
            model: KNOWN_ANTHROPIC_MODEL,
            protocol: "anthropic",
            provenance: identity.provenance,
            requestModel: REQUEST_ALIAS,
          },
          role: "assistant",
          toolCalls: [],
        },
        TEST_NOW + 2,
      );
      const model = createScriptedAgentModel([
        { content: "Reloaded completion", toolCalls: [] },
      ]);
      const runtime = {
        ...runtimeDefaults(),
        credential,
        continuous: true,
        detail,
        isCurrent: () => true,
        modelFactory: () => model,
        modelFetch: () =>
          Promise.resolve(Response.json({ id: KNOWN_ANTHROPIC_MODEL })),
        now: () => TEST_NOW + 3,
        store: setup.store,
      };

      await expect(execute(runtime)).resolves.toBe("complete");

      expect(
        model.requests[0]?.find(
          (message) => message.content === "Persisted answer",
        ),
      ).toMatchObject({
        providerReplay: { provenance: identity.provenance },
      });
      closeSessionTestDatabase(setup.database);
    },
  );

  test("retries a transient startup resolution on a later completion in the same run", async () => {
    const setup = runningCompactionStore();
    const detail = {
      ...requireCompactionSession(setup.store),
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
          return response === undefined
            ? Promise.reject(new Error("No completion response remains"))
            : Promise.resolve(response);
        },
      });
    let now = TEST_NOW + 2;

    await expect(
      runSessionAgent({
        ...runtimeDefaults(),
        credential: {
          ...ANTHROPIC_TEST_CREDENTIAL,
          isDefault: true,
          label: "Anthropic test",
        },
        detail,
        isCurrent: () => true,
        modelFactory,
        modelFetch: (request) => {
          retrievals.push(request);
          return Promise.reject(new TypeError("temporary retrieval failure"));
        },
        now: () => (now += 1),
        sessionTools: unusedSessionToolActions({
          listSessions: () => "session list",
        }),
        store: setup.store,
      }),
    ).resolves.toBe("complete");

    expect(retrievals).toHaveLength(2);
    expect(completions).toHaveLength(2);
    closeSessionTestDatabase(setup.database);
  });
});
