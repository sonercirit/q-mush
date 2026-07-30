import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { SessionAgentRuntimeDependencies } from "../session-agent-runtime.ts";

function completeTestBrokerCommand(
  broker: RunnerCommandBroker,
  runnerId: string,
  command: { readonly id: string },
): void {
  broker.complete(runnerId, command.id, {
    output: "null",
    state: "completed",
  });
}

export function completingTestBroker(): RunnerCommandBroker {
  let commandId = 0;
  const broker = new RunnerCommandBroker({
    commandId: () => `command-${String((commandId += 1))}`,
    deliver: (runnerId, command) => {
      queueMicrotask(() => {
        completeTestBrokerCommand(broker, runnerId, command);
      });
      return true;
    },
  });
  return broker;
}

export const IDLE_RUNTIME_SIGNALS: Pick<
  SessionAgentRuntimeDependencies,
  "hasPendingSteeringInput" | "notify" | "realtime" | "restartHandoffRequested"
> = {
  hasPendingSteeringInput: () => false,
  notify: () => undefined,
  realtime: undefined,
  restartHandoffRequested: () => false,
};
