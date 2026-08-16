import { expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { testDeferred } from "../../shared/test/promise-fixtures.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  scriptedModel,
  startToolSessionSetup,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeRunnerCommand,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const ATTACHMENT = {
  data: "AQ==",
  mediaType: "application/pdf",
  name: "deferred.pdf",
} as const;

function currentModelCatalog() {
  return {
    defaultModel: "gpt-4.1-mini",
    models: [
      testAgentModelOption({
        id: "gpt-4.1-mini",
        inputModalities: ["text", "file"],
      }),
    ],
  };
}

function explainFileModel(): AgentModel {
  return scriptedModel([
    {
      content: "Explain the deferred PDF.",
      toolCalls: [toolCall("explain_file", { path: "deferred.pdf" })],
    },
    { content: "Explanation must not start.", toolCalls: [] },
  ]);
}

test("a deferred explain_file discovery cannot start its auxiliary model after drain", async () => {
  const discovered = testDeferred<undefined>();
  let discoveryCalls = 0;
  let modelRequests = 0;
  const delegated = explainFileModel();
  const model: AgentModel = {
    complete: (...parameters) => {
      modelRequests += 1;
      return delegated.complete(...parameters);
    },
  };
  const setup = connectedSessionSetup(model, "api_key", () => {
    discoveryCalls += 1;
    return discoveryCalls === 1
      ? Promise.resolve(currentModelCatalog())
      : discovered.promise.then(currentModelCatalog);
  });
  await startToolSessionSetup(setup);
  await waitForSessionValue(setup.latestRunnerCommand, (command) =>
    isRecord(command) ? command["tool"] === "explain_file" : false,
  );
  expect(completeRunnerCommand(setup, JSON.stringify(ATTACHMENT)).status).toBe(
    204,
  );
  await waitForSessionValue(
    () => discoveryCalls,
    (calls) => calls === 2,
  );

  const drain = setup.sessions.drain();
  discovered.resolve(undefined);
  await drain;

  expect(modelRequests).toBe(1);
  closeSessionTestDatabase(setup.database);
});

test("restart progress tracks an in-process sleep tool", async () => {
  const steps = [
    providerStep("Wait inside the engine.", {
      toolCalls: [toolCall("sleep", { durationSeconds: 60 })],
    }),
    providerStep("Finished."),
  ];
  const model: AgentModel = {
    complete: () =>
      Promise.resolve(steps.shift() ?? providerStep("Unexpected step.")),
  };
  const setup = connectedSessionSetup(model);
  await startToolSessionSetup(setup);
  const sleeping = () => {
    const detail = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    return detail?.messages.some(({ content }) =>
      content.includes("Wait inside"),
    );
  };
  await waitForSessionValue(sleeping, Boolean);
  const drain = setup.sessions.drain();
  const reportsSleep = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    return value.some((entry: unknown) => {
      if (!isRecord(entry)) return false;
      const tools = entry["tools"];
      return Array.isArray(tools) && tools.includes("sleep");
    });
  };
  await waitForSessionValue(
    setup.sessions.drainProgress.bind(setup.sessions),
    reportsSleep,
  );
  setup.sessions.escalateDrain();
  await drain;
  closeSessionTestDatabase(setup.database);
});
