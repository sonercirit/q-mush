import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionViewState } from "./session-client.tsx";

export function sessionComposerUnavailableReason(
  detail: AgentSessionDetail,
  state: SessionViewState,
  runnerAvailable: boolean | undefined,
  credentialAvailable: boolean | undefined,
): string | undefined {
  if (state.loadingDetail) {
    return "Refreshing session state…";
  }
  if (state.sending) {
    return "Sending…";
  }
  if (state.stopping) {
    return "Stopping…";
  }
  if (state.compacting) {
    return "Compacting…";
  }
  if (detail.status === "queued" || detail.status === "running") {
    return undefined;
  }
  if (runnerAvailable === undefined) {
    return "Checking whether the session runner is available…";
  }
  if (credentialAvailable === undefined) {
    return "Checking whether the session credential is available…";
  }
  if (detail.status === "failed") {
    if (!runnerAvailable) {
      return "The failed session cannot resume because its runner is offline or unavailable.";
    }
    if (!credentialAvailable) {
      return "The failed session cannot resume because its credential is unavailable.";
    }
    return undefined;
  }
  if (detail.status === "stopped") {
    if (!runnerAvailable) {
      return "The stopped session cannot resume because its runner is offline or unavailable.";
    }
    if (!credentialAvailable) {
      return "The stopped session cannot resume because its credential is unavailable.";
    }
    return undefined;
  }
  if (!runnerAvailable) {
    return "The session runner is offline or unavailable.";
  }
  return credentialAvailable
    ? undefined
    : "The session credential is unavailable.";
}
