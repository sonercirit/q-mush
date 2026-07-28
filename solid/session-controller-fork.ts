import type { SessionForkSelection } from "../shared/session-fork.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import type { SessionCreationViewOptions } from "./session-controller-options.ts";
import { newestSessionHistoryState } from "./session-history-state.ts";
import { reconcileUnknownSessionMutation } from "./session-mutation-reconciliation.ts";
import { sessionMutationError } from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";

function selectedForkDetail(options: SessionCreationViewOptions) {
  const detail = options.view.value.detail;
  return detail !== undefined && detail.id === options.view.value.selectedId
    ? detail
    : undefined;
}

function realtimeForkDetail(options: SessionCreationViewOptions) {
  const transport = options.transport;
  const detail = selectedForkDetail(options);
  const sessions = options.view.value.sessions;
  if (
    transport === undefined ||
    detail === undefined ||
    sessions === undefined
  ) {
    throw new Error("fork_realtime_required");
  }
  return { detail, sessions, transport };
}

function forkSuccessState(
  view: RevisionState<SessionViewState>,
  forked: ReturnType<typeof readSessionDetail>,
): Partial<SessionViewState> {
  return sessionDetailState(view.value, forked, {
    followUp: "",
    followUpImages: [],
    forking: false,
    history: newestSessionHistoryState(forked.hasOlderSegments),
    loadingDetail: false,
    selectedId: forked.id,
    toolStreams: [],
  });
}

function rejectFork(
  view: RevisionState<SessionViewState>,
  revision: number,
  error: unknown,
): void {
  view.patchCurrent(revision, {
    error: sessionMutationError(error, "fork that session"),
    forking: false,
  });
}

export async function forkSessionFromView(
  options: SessionCreationViewOptions & {
    readonly forkPointMessageId: string;
    readonly selection?: SessionForkSelection | undefined;
  },
): Promise<void> {
  if (sessionMutationPending(options.view.value)) {
    return;
  }
  let realtime: ReturnType<typeof realtimeForkDetail>;
  try {
    realtime = realtimeForkDetail(options);
  } catch {
    options.view.patch({ error: "Forking a session requires realtime." });
    return;
  }
  const { detail, sessions, transport } = realtime;
  const previousIds = new Set(sessions.map(({ id: sessionId }) => sessionId));
  const revision = options.view.begin({ forking: true });
  options.view.patch({ error: undefined });
  options.loader.noteMutationStarted();
  try {
    const forked = readSessionDetail(
      await transport.command(SESSION_REALTIME_OPERATIONS.fork, {
        forkPointMessageId: options.forkPointMessageId,
        ...options.selection,
        sourceSessionId: detail.id,
        workspaceId: detail.workspaceId,
      }),
    );
    options.view.patchCurrentWith(revision, () =>
      forkSuccessState(options.view, forked),
    );
  } catch (error) {
    await reconcileUnknownSessionMutation({
      error,
      reconcile: async (normalized) => {
        await options.reconciliation.fork(revision, normalized, previousIds);
      },
      reject: (normalized) => {
        rejectFork(options.view, revision, normalized);
      },
    });
  } finally {
    const forkLoader = options.loader;
    forkLoader.continueHydration();
  }
}
