import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import {
  expectAgentMessageRejected,
  expectSessionUnchanged,
  fenceTestSession,
  type HardeningStoreSetup,
} from "./session-reassignment-hardening-helpers.ts";
import { createSessionStoreTestSetup } from "./session-store-test-helpers.ts";

const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";

export interface RejectedWriteSetup {
  readonly before: AgentSessionDetail | undefined;
  readonly setup: HardeningStoreSetup;
}

function rejectedWriteSetup(
  setup: HardeningStoreSetup,
  runnerId: string,
): RejectedWriteSetup {
  const before = fenceTestSession(setup, runnerId);
  return { before, setup };
}

export function expectRejectedWrite(
  rejected: RejectedWriteSetup,
  message: AgentRecordedMessage,
  generation?: number,
): void {
  expectAgentMessageRejected(
    rejected.setup.store,
    SESSION_ID,
    message,
    generation,
  );
  expectSessionUnchanged(rejected.setup.store, SESSION_ID, rejected.before);
}

function performLateModelWrites(store: SessionStore): void {
  expectAgentMessageRejected(store, SESSION_ID, {
    content: "Late model output",
    role: "assistant",
    toolCalls: [],
  });
  store.updateUsage(
    SESSION_ID,
    { contextTokens: 10, costBasis: "reported", costUsd: 1 },
    TEST_NOW + 3,
  );
  store.setAgentFile(SESSION_ID, null, TEST_NOW + 3);
}

export function withRejectedWriteSetup(
  runnerId: string,
  assertRejected: (rejected: RejectedWriteSetup) => void,
): void {
  const setup = createSessionStoreTestSetup();
  assertRejected(rejectedWriteSetup(setup, runnerId));
  setup.database.$client.close();
}

export function expectLateModelWritesRejected(
  rejected: RejectedWriteSetup,
): void {
  const { store } = rejected.setup;
  performLateModelWrites(store);
  expectSessionUnchanged(store, SESSION_ID, rejected.before);
}
