import { createUuidV7 } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  responseToolOutput,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";
import { sessionToolOutput } from "./session-agent-tools.ts";

type SessionControlBaseDependencies = Pick<
  SessionAgentActionDependencies,
  "notify" | "now" | "store"
>;

interface SessionCompactionDependencies extends SessionControlBaseDependencies {
  readonly compactSession: (
    userId: string,
    sessionId: string,
    workspaceId: string,
  ) => Promise<Response>;
  readonly scheduleCompaction: (
    sessionId: string,
    generation: number,
  ) => "already_pending" | "scheduled" | "unavailable";
}

export function sessionControlDependencies(
  dependencies: SessionControlBaseDependencies,
): SessionControlBaseDependencies {
  return {
    now: dependencies.now,
    store: dependencies.store,
    notify: dependencies.notify,
  };
}

function requireOwnedTarget(
  dependencies: SessionControlBaseDependencies,
  selection: {
    readonly sessionId: string;
    readonly userId: string;
    readonly workspaceId: string;
  },
): AgentSessionDetail {
  const target = dependencies.store.get(
    selection.userId,
    selection.sessionId,
    selection.workspaceId,
  );
  if (target === undefined) {
    throw new Error("Session not found");
  }
  return target;
}

export async function compactSessionAction(
  dependencies: SessionCompactionDependencies,
  userId: string,
  sessionId: string,
  workspaceId: string,
): Promise<string> {
  const target = requireOwnedTarget(dependencies, {
    sessionId,
    userId,
    workspaceId,
  });
  if (target.status === "running") {
    const scheduled = dependencies.scheduleCompaction(
      sessionId,
      target.generation,
    );
    if (scheduled === "unavailable") {
      throw new Error("The running session is unavailable");
    }
    if (scheduled === "already_pending") {
      return sessionToolOutput({
        sessionId,
        status: "compaction_already_scheduled",
      });
    }
  } else {
    const response = await dependencies.compactSession(
      userId,
      sessionId,
      workspaceId,
    );
    if (!response.ok) {
      return responseToolOutput(response);
    }
  }
  return sessionToolOutput({ sessionId, status: "compaction_scheduled" });
}

export function steerSessionAction(
  dependencies: SessionControlBaseDependencies,
  userId: string,
  sessionId: string,
  message: string,
  workspaceId: string,
): string {
  const target = requireOwnedTarget(dependencies, {
    userId,
    workspaceId,
    sessionId,
  });
  if (target.status !== "running") {
    throw new Error(
      "steer_session requires a running session; use send_to_session for a non-running session",
    );
  }
  const result = dependencies.store.enqueuePendingInput(
    userId,
    sessionId,
    {
      clientRequestId: `agent-steer:${createUuidV7()}`,
      content: message,
      images: [],
      kind: "steer",
    },
    dependencies.now(),
  );
  if (result.status !== "accepted") {
    throw new Error(
      result.status === "invalid_state"
        ? "steer_session requires a running session; use send_to_session for a non-running session"
        : `The steering message was not accepted: ${result.status}`,
    );
  }
  dependencies.notify(userId, sessionId);
  return sessionToolOutput({ sessionId, status: "steering_scheduled" });
}
