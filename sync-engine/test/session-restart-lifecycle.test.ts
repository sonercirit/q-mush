import { test } from "vitest";
import { RUNNER_ID } from "./session-integration-fixtures.ts";
import {
  type DrainedTerminalAssertionInput,
  expectDrainedTerminalSession,
  expectSingleTranscriptOccurrence,
  reconnectRunnerAndExpectNoReplay,
} from "./session-integration-helpers.ts";

test("replays ordinary connected callbacks without duplicate completed work", async () => {
  const expectReconnectReplay = async ({
    model,
    setup,
    terminal,
  }: DrainedTerminalAssertionInput): Promise<void> => {
    expectSingleTranscriptOccurrence(terminal, "One durable answer.");
    await reconnectRunnerAndExpectNoReplay(setup, model, RUNNER_ID, 2);
  };
  await expectDrainedTerminalSession(expectReconnectReplay);
});
