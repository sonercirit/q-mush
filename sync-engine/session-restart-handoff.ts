import type { RestartHandoff } from "../shared/session-model.ts";

export function restartHandoffValues(handoff: RestartHandoff): RestartHandoff {
  return {
    executionGeneration: handoff.executionGeneration,
    operation: handoff.operation,
    pendingInput: [],
    requestedBy: handoff.requestedBy,
    restartId: handoff.restartId,
  };
}
