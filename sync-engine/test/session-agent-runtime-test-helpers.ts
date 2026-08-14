import { expect } from "vitest";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { SessionAgentRuntimeDependencies } from "../session-agent-runtime.ts";

function completeTestBrokerCommand(
  broker: RunnerCommandBroker,
  runnerId: string,
  command: { readonly id: string },
  output: string,
): void {
  broker.complete(runnerId, command.id, {
    output,
    state: "completed",
  });
}

export function completingTestBroker(
  completes: (tool: string) => boolean = () => true,
  outputFor: (tool: string) => string = () => "null",
): RunnerCommandBroker {
  let commandId = 0;
  const broker = new RunnerCommandBroker({
    commandId: () => `command-${String((commandId += 1))}`,
    deliver: (runnerId, command) => {
      if (!completes(command.tool)) return true;
      queueMicrotask(() => {
        completeTestBrokerCommand(
          broker,
          runnerId,
          command,
          outputFor(command.tool),
        );
      });
      return true;
    },
  });
  return broker;
}

export async function completedRunToolOutputs(
  run: Promise<"complete" | "handoff">,
  store: {
    conversation: (
      sessionId: string,
    ) => readonly { readonly content: string; readonly role: string }[];
  },
  sessionId: string,
): Promise<readonly string[]> {
  expect(await run).toBe("complete");
  return store
    .conversation(sessionId)
    .filter(({ role }) => role === "tool")
    .map(({ content }) => content);
}

export function runtimeTestCredential(credentialId: string, label: string) {
  return {
    accountId: null,
    id: credentialId,
    isDefault: true,
    label,
    secret: "provider-secret",
    source: "api_key" as const,
  };
}

export const IDLE_RUNTIME_SIGNALS: Pick<
  SessionAgentRuntimeDependencies,
  | "continuous"
  | "hasPendingSteeringInput"
  | "manualCompactionRequested"
  | "notify"
  | "realtime"
  | "restartHandoffRequested"
> = {
  continuous: false,
  hasPendingSteeringInput: () => false,
  manualCompactionRequested: () => false,
  notify: () => undefined,
  realtime: undefined,
  restartHandoffRequested: () => false,
};
