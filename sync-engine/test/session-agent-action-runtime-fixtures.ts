import type { SessionAgentActionDependencies } from "../session-agent-action-helpers.ts";

function freshRestartSignal(): AbortSignal {
  return new AbortController().signal;
}

export function emptyRunnerOptions() {
  return { items: [], totalItems: 0 };
}

export function sessionAgentActionRuntimeDefaults(): Pick<
  SessionAgentActionDependencies,
  "notify" | "pendingRestart" | "restartSignal" | "runnerIsAvailable"
> & { readonly listRunnerOptions: typeof emptyRunnerOptions } {
  return {
    listRunnerOptions: emptyRunnerOptions,
    notify: () => undefined,
    pendingRestart: () => undefined,
    restartSignal: freshRestartSignal,
    runnerIsAvailable: () => true,
  };
}
