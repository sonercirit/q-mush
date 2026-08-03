import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionController } from "./session-controller.ts";
import type { SessionDraft } from "./session-view-state.ts";

interface DefaultSessionController {
  readonly currentDraft: SessionDraft;
  readonly detail: AgentSessionDetail | undefined;
  ensureModels(credential: string): void;
  patchDraft(draft: SessionDraft): void;
}

export function initializeSessionDefaults(
  controller: DefaultSessionController,
  runnerId: string,
  credential: string,
  credentialsSettled: boolean,
): void {
  const draft = controller.currentDraft;
  const selectedCredential =
    credentialsSettled && draft.credential.length === 0
      ? credential
      : draft.credential;
  const next = {
    ...draft,
    credential: selectedCredential,
    ...(selectedCredential === draft.credential
      ? {}
      : { model: "", openRouterProviderTag: "", reasoningEffort: "" }),
    runnerId: draft.runnerId.length === 0 ? runnerId : draft.runnerId,
  };
  if (
    next.credential !== draft.credential ||
    next.runnerId !== draft.runnerId
  ) {
    controller.patchDraft(next);
  }
  if (next.credential.length > 0) controller.ensureModels(next.credential);
}

interface SessionDirectoryController {
  readonly detail: AgentSessionDetail | undefined;
  readonly directoryPicker: {
    open(
      runnerId: string,
      path: string,
      workspaceId: string | undefined,
    ): Promise<void>;
  };
  readonly state: Pick<SessionController["state"], "draft" | "reassignment">;
}

export function openSessionDirectoryPicker(
  controller: SessionDirectoryController,
): void {
  const selection =
    controller.detail?.runnerRequired === true
      ? controller.state.reassignment
      : controller.state.draft;
  if (selection.runnerId.length > 0) {
    void controller.directoryPicker.open(
      selection.runnerId,
      selection.workingDirectory.trim() || "~",
      controller.detail?.workspaceId,
    );
  }
}
