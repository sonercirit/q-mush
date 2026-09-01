import { Database } from "bun:sqlite";
import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store";
import { decodeOperationCheckpoint } from "../shared/operation-checkpoint";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import { createOperationStore } from "../sync-engine/operation-store";
import { createPromptStore } from "../sync-engine/prompt-store";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "../sync-engine/test/authenticated-integration-test-helpers";
import { createWorkspaceStore } from "../sync-engine/workspace-store";
import { commandStoreResources } from "./operation-command-test-support";

test("engine command envelopes converge to the same runner projection", () => {
  const { database, generateId } = commandStoreResources();
  const workspaces = createWorkspaceStore(database, generateId);
  const first = workspaces.createDefault(TEST_USER_ID, TEST_NOW);
  const second = workspaces.create(TEST_USER_ID, "Second", TEST_NOW + 1);
  workspaces.rename(TEST_USER_ID, second?.id ?? "", "Renamed", TEST_NOW + 2);
  workspaces.remove(TEST_USER_ID, first.id, TEST_NOW + 3);
  const prompts = createPromptStore(database, generateId);
  const prompt = prompts.create(
    TEST_USER_ID,
    { name: "Prompt", body: "Old" },
    TEST_NOW + 4,
  );
  prompts.update(
    TEST_USER_ID,
    prompt.id,
    { name: "Prompt", body: "New" },
    TEST_NOW + 5,
    1,
  );
  const engineStore = createOperationStore({ database });
  const page = engineStore.readEncodedEnvelopes(
    TEST_USER_ID,
    "non-session",
    {},
    256,
  );
  const runnerDatabase = new Database(":memory:");
  const runner = createRunnerOperationStore(runnerDatabase);
  runner.apply(TEST_USER_ID, "non-session", page.envelopes, "remote");
  const engine = decodeOperationCheckpoint(
    engineStore.loadCheckpoint(TEST_USER_ID, "non-session") ?? "",
    operationEntityProjectionCodec,
  );
  const checkpoint = runner.state(TEST_USER_ID, "non-session");
  expect(checkpoint.projection).toEqual(engine.projection);
  expect(checkpoint.projection.users[0]?.effectiveDefaultWorkspaceId).toBe(
    second?.id,
  );
  runnerDatabase.close();
  database.$client.close();
});
