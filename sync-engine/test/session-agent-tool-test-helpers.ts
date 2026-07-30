import type { SessionAgentToolActions } from "../session-agent-tools.ts";

export function unusedSessionToolActions(
  overrides: Partial<SessionAgentToolActions> = {},
): SessionAgentToolActions {
  return {
    browseRunnerDirectories: () => Promise.resolve("unused directories"),
    continueSession: () => Promise.resolve("unused continuation"),
    getSessionOptions: () => Promise.resolve("unused options"),
    listRunners: () => "unused runners",
    listSessions: () => "unused sessions",
    readSession: () => "unused session",
    reassignSession: () => "unused reassignment",
    sendToSession: () => Promise.resolve("unused message"),
    spawnSession: () => Promise.resolve("unused spawn"),
    stopSession: () => "unused stop",
    ...overrides,
  };
}
