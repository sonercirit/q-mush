import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type {
  SessionRealtimeActionResult,
  WorkspaceSessionRealtimeActionOptions,
} from "./session-realtime-action-types.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface StopSessionStore {
  get: SessionStore["get"];
  stop: SessionStore["stop"];
}

type StopSessionClock = () => number;
type StopSessionNotification = (ownerId: string, changedId: string) => void;

interface StopSessionDependencies {
  readonly actions: {
    readonly finished: SessionAgentActions["finished"];
    readonly stopChildren: SessionAgentActions["stopChildren"];
    readonly stopSession: SessionAgentActions["stopSession"];
  };
  readonly notify: StopSessionNotification;
  readonly now: StopSessionClock;
  readonly runtimes: Pick<SessionRuntimes, "cleared">;
  readonly store: StopSessionStore;
}

function detail(
  dependencies: StopSessionDependencies,
  userId: string,
  sessionId: string,
  workspaceId: string,
): AgentSessionDetail {
  const value = dependencies.store.get(userId, sessionId, workspaceId);
  if (value === undefined) throw createRealtimeCommandError("not_found");
  return value;
}

export async function stopSessionForUser(
  options: Omit<WorkspaceSessionRealtimeActionOptions<never>, "input"> & {
    readonly cascade: boolean;
    readonly dependencies: StopSessionDependencies;
    readonly sessionId: string;
  },
): SessionRealtimeActionResult {
  const { cascade, dependencies, sessionId, user, workspaceId } = options;
  detail(dependencies, user.id, sessionId, workspaceId);
  const current = detail(dependencies, user.id, sessionId, workspaceId);
  if (current.status !== "stopped") {
    dependencies.actions.stopSession(sessionId, current);
    await dependencies.runtimes.cleared(sessionId);
    dependencies.store.stop(user.id, sessionId, dependencies.now());
    if (cascade) dependencies.actions.stopChildren(current, user.id);
  }
  const stopped = detail(dependencies, user.id, sessionId, workspaceId);
  dependencies.actions.finished(stopped, user.id);
  dependencies.notify(user.id, sessionId);
  return stopped;
}
