import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import {
  removeSessionImage,
  updatedSessionImages,
} from "./session-controller-images.ts";
import type { SessionLoadController } from "./session-controller-load.ts";
import type {
  DetailMutationOptions,
  SessionReconciliationController,
} from "./session-controller-reconciliation.ts";
import type { SessionRealtimeState } from "./session-controller-state.ts";
import { reconcileUnknownSessionMutation } from "./session-mutation-reconciliation.ts";
import {
  executeSessionMutation,
  reassignSessionMutation,
  sessionMutationError,
} from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";
import { emptySessionReassignmentDraft } from "./session-reassignment-client.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export async function addSessionImages(options: {
  readonly files: readonly File[];
  readonly follow: boolean;
  readonly view: RevisionState<SessionViewState>;
}): Promise<void> {
  const current = options.follow
    ? options.view.value.followUpImages
    : options.view.value.draft.images;
  try {
    const images = await updatedSessionImages(options.files, current);
    options.view.patch(
      options.follow
        ? { error: undefined, followUpImages: images }
        : {
            draft: { ...options.view.value.draft, images },
            error: undefined,
          },
    );
  } catch (error) {
    options.view.patch({
      error:
        error instanceof Error
          ? error.message
          : "We could not attach those images.",
    });
  }
}

export function removeSessionControllerImage(options: {
  readonly index: number;
  readonly target: "draft" | "followUp";
  readonly view: RevisionState<SessionViewState>;
}): void {
  const images =
    options.target === "draft"
      ? options.view.value.draft.images
      : options.view.value.followUpImages;
  const remaining = removeSessionImage(images, options.index);
  if (remaining === undefined) {
    return;
  }
  options.view.patch(
    options.target === "draft"
      ? { draft: { ...options.view.value.draft, images: remaining } }
      : { followUpImages: remaining },
  );
}

interface DetailMutationDependencies {
  readonly loader: SessionLoadController;
  readonly realtime: SessionRealtimeState;
  readonly reconciliation: SessionReconciliationController;
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}

export async function mutateSessionDetail(
  dependencies: DetailMutationDependencies,
  mutation: DetailMutationOptions,
  rethrowRejection = false,
): Promise<void> {
  let rejection: unknown;
  const pending = { [mutation.pending]: true };
  const settled = { [mutation.pending]: false };
  const baseline = dependencies.view.value.detail;
  if (baseline === undefined || baseline.id !== mutation.payload["sessionId"]) {
    return;
  }
  const revision = dependencies.view.begin({ error: undefined, ...pending });
  dependencies.loader.noteMutationStarted();
  try {
    if (dependencies.transport === undefined) {
      throw new Error("outcome_unknown");
    }
    const detail = await executeSessionMutation(
      dependencies.transport,
      mutation,
    );
    if (
      dependencies.view.patchCurrent(revision, {
        ...settled,
        ...mutation.success,
      })
    ) {
      dependencies.realtime.applyDetail(detail);
    }
  } catch (error) {
    await reconcileUnknownSessionMutation({
      error,
      reconcile: (normalized) =>
        dependencies.reconciliation.detail(
          revision,
          normalized,
          mutation,
          baseline,
        ),
      reject: (normalized) => {
        rejection = normalized;
        dependencies.view.patchCurrent(revision, {
          ...settled,
          error: sessionMutationError(normalized, mutation.action),
        });
      },
    });
  } finally {
    dependencies.loader.continueHydration();
  }
  if (rethrowRejection && rejection !== undefined) {
    throw rejection instanceof Error
      ? rejection
      : new Error("Session mutation rejected", { cause: rejection });
  }
}

export async function reassignSessionFromView(
  dependencies: DetailMutationDependencies,
  onlineRunnerIds: readonly string[],
): Promise<void> {
  const detail = dependencies.view.value.detail;
  const sessionId = dependencies.view.value.selectedId;
  const input = dependencies.view.value.reassignment;
  if (
    sessionId === undefined ||
    detail?.id !== sessionId ||
    !detail.runnerRequired ||
    sessionMutationPending(dependencies.view.value) ||
    !onlineRunnerIds.includes(input.runnerId) ||
    input.workingDirectory.trim().length === 0
  ) {
    dependencies.view.patch({
      error:
        "Choose an online replacement runner and confirm a working directory on it.",
    });
    return;
  }
  await mutateSessionDetail(dependencies, {
    ...reassignSessionMutation(
      sessionId,
      input.runnerId,
      input.workingDirectory.trim(),
    ),
    success: { reassignment: emptySessionReassignmentDraft() },
  });
}
