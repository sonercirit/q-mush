import type { SessionAgentToolName } from "../shared/agent-tools.ts";
import {
  abortSignalError,
  throwIfSignalAborted,
} from "../shared/validation.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import {
  compactSessionAction,
  sessionControlDependencies,
  steerSessionAction,
} from "./session-agent-control-actions.ts";
import type { startManualSessionCompactionForUserId } from "./session-compaction-actions.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

export interface SessionControlActionDependencies extends SessionAgentActionDependencies {
  readonly compactSession?: typeof startManualSessionCompactionForUserId;
  readonly runtimes?: SessionRuntimes;
}

function compactionDependencies(
  dependencies: SessionControlActionDependencies,
) {
  const compactSession = dependencies.compactSession;
  const runtimes = dependencies.runtimes;
  if (compactSession === undefined || runtimes === undefined) {
    throw new Error("Session compaction is unavailable");
  }
  return { compactSession, runtimes };
}

interface SessionControlSelection {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface CompactionSelection extends SessionControlSelection {
  readonly authority: SessionExecutionAuthority & {
    readonly tool: Extract<SessionAgentToolName, "compact_session">;
  };
  readonly signal: AbortSignal;
}

interface SteeringSelection extends SessionControlSelection {
  readonly message: string;
  readonly signal: AbortSignal;
}

export function compactSessionForAgent(
  dependencies: SessionControlActionDependencies,
  selection: CompactionSelection,
): Promise<string> {
  const { compactSession, runtimes } = compactionDependencies(dependencies);
  return compactSessionAction(
    {
      ...sessionControlDependencies(dependencies),
      compactSession: (ownerId, targetId, targetWorkspaceId) =>
        compactSession(
          {
            credential: (userId, detail, action) =>
              dependencies.withCredential(userId, detail, (credential) => {
                // Credential access can outlive the tool deadline; never
                // queue or launch after the caller reported timed-out.
                if (selection.signal.aborted) {
                  throw abortSignalError(
                    selection.signal,
                    "The compaction was canceled",
                  );
                }
                return action(credential);
              }),
            launch: (detail, credential, owner, operation) =>
              dependencies.launchSession(credential, detail, owner, operation),
            notify: dependencies.notify,
            now: dependencies.now,
            operation: "compact_and_continue",
            parentAuthority: selection.authority,
            runtimes,
            store: dependencies.store,
            workspaceId: targetWorkspaceId,
          },
          ownerId,
          targetId,
        ),
      scheduleCompaction: (targetId, generation) =>
        runtimes.activeGenerationMatches(targetId, generation)
          ? dependencies.store.scheduleManualCompaction(
              targetId,
              generation,
              dependencies.now(),
            )
          : "unavailable",
    },
    selection.userId,
    selection.sessionId,
    selection.workspaceId,
  );
}

export function steerSessionForAgent(
  dependencies: SessionControlActionDependencies,
  selection: SteeringSelection,
): Promise<string> {
  throwIfSignalAborted(selection.signal, "The steering was canceled");
  const output = steerSessionAction(
    {
      notify: (...parameters) => {
        dependencies.notify(...parameters);
      },
      now: dependencies.now,
      store: dependencies.store,
    },
    selection.userId,
    selection.sessionId,
    selection.message,
    selection.workspaceId,
  );
  return Promise.resolve(output);
}
