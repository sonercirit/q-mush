import { sessionCanResume } from "./session-controller-guards.ts";
import {
  contextTokenCapMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import type { SessionViewState } from "./session-view-state.ts";

type ContextCapState = Pick<SessionViewState, "detail" | "selectedId">;

export interface ContextTokenCapController {
  compact(): Promise<void>;
  mutateContextTokenCap(mutation: SessionMutation): Promise<void>;
  readonly view: () => SessionViewState;
}

export async function updateSessionContextTokenCap(
  controller: ContextTokenCapController,
  userContextTokenCap: number | null,
  compactIfExceeded = false,
): Promise<void> {
  await setSessionContextTokenCap(
    controller.view,
    userContextTokenCap,
    compactIfExceeded,
    controller.mutateContextTokenCap.bind(controller),
    async () => controller.compact(),
  );
}

async function setSessionContextTokenCap(
  readState: () => ContextCapState,
  userContextTokenCap: number | null,
  compactIfExceeded: boolean,
  mutate: (mutation: SessionMutation) => Promise<void>,
  compact: () => Promise<void>,
): Promise<void> {
  const initial = readState();
  const detail = initial.detail;
  if (detail === undefined || detail.id !== initial.selectedId) return;
  await mutate(contextTokenCapMutation(detail.id, userContextTokenCap));
  const acknowledgedState = readState();
  const acknowledged = acknowledgedState.detail;
  if (
    compactIfExceeded &&
    userContextTokenCap !== null &&
    acknowledged !== undefined &&
    acknowledged.id === acknowledgedState.selectedId &&
    acknowledged.userContextTokenCap === userContextTokenCap &&
    acknowledged.autoCompact &&
    acknowledged.currentContextTokens > userContextTokenCap &&
    sessionCanResume(acknowledged.status)
  ) {
    await compact();
  }
}
