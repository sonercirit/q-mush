import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoff,
} from "../shared/session-model.ts";
import type {
  RestartSessionLaunch,
  SessionNotification,
} from "./session-creation.ts";
import type {
  RestartHandoffStore,
  InvalidRestartSession,
  PendingRestartSession,
  RestartHandoffIdentity,
} from "./session-restart-store.ts";
import {
  sessionRunnerIsAvailable,
  type SessionRunnerAvailability,
} from "./session-runner-availability.ts";

export interface RestartCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId: string;
}

type FailInvalidRestartHandoff = RestartHandoffStore["failInvalid"];

interface SessionRestartRecoveryStore {
  readonly failInvalidRestartHandoff: FailInvalidRestartHandoff;
  readonly failRestartHandoff: (
    userId: string,
    identity: RestartHandoffIdentity,
    error: string,
    now: number,
  ) => boolean;
  readonly invalidRestartHandoffs: (
    runnerId?: string,
  ) => readonly InvalidRestartSession[];
  claimRestartHandoff(
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ): AgentSessionDetail | undefined;
  readonly pendingRestartHandoffs: (
    runnerId?: string,
  ) => readonly PendingRestartSession[];
  readonly restoreRestartHandoff: (
    identity: RestartHandoffIdentity,
    now: number,
  ) => boolean;
}

export interface RestartRecoveryBoundary {
  readonly launch: RestartSessionLaunch;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly restartId?: string;
  readonly runnerIsAvailable: SessionRunnerAvailability;
  readonly store: SessionRestartRecoveryStore;
}

interface SessionRestartRecoveryDependencies extends RestartRecoveryBoundary {
  readonly credential: (
    userId: string,
    selection: RestartCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
}

function handoffsMatch(left: RestartHandoff, right: RestartHandoff): boolean {
  return (
    left.executionGeneration === right.executionGeneration &&
    left.operation === right.operation &&
    left.requestedBy === right.requestedBy &&
    left.restartId === right.restartId
  );
}

function restoreClaim(
  dependencies: SessionRestartRecoveryDependencies,
  identity: RestartHandoffIdentity,
): void {
  dependencies.store.restoreRestartHandoff(identity, dependencies.now());
}

function handoffIdentity(
  pending: PendingRestartSession,
): RestartHandoffIdentity {
  return {
    generation: pending.detail.generation,
    restartId: pending.handoff.restartId,
    sessionId: pending.detail.id,
  };
}

interface RestartRecoveryResult {
  readonly pendingCredentials: boolean;
  readonly pendingLaunches: boolean;
}

function restartFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return `Session failed: ${error.message.slice(0, 500)}`;
  }
  return "Session failed: Unknown error";
}

const RECOVERY_COMPLETE: RestartRecoveryResult = {
  pendingCredentials: false,
  pendingLaunches: false,
};

const RECOVERY_RETRY_LAUNCH: RestartRecoveryResult = {
  pendingCredentials: false,
  pendingLaunches: true,
};

async function recoverOne(
  dependencies: SessionRestartRecoveryDependencies,
  pending: PendingRestartSession,
): Promise<RestartRecoveryResult> {
  if (
    pending.handoff.requestedBy === "runner" &&
    pending.handoff.restartId !== dependencies.restartId
  ) {
    return RECOVERY_COMPLETE;
  }
  if (
    !sessionRunnerIsAvailable(
      dependencies.runnerIsAvailable,
      pending.userId,
      pending.detail,
    )
  ) {
    return RECOVERY_COMPLETE;
  }
  let credential: ProviderCredentialAccess | undefined;
  try {
    credential = await dependencies.credential(pending.userId, {
      credentialId: pending.detail.credentialId,
      provider: pending.detail.provider,
      workspaceId: pending.detail.workspaceId,
    });
  } catch {
    return { pendingCredentials: true, pendingLaunches: false };
  }
  if (credential === undefined) {
    return { pendingCredentials: true, pendingLaunches: false };
  }
  const handoff = pending.detail.restartHandoff;
  if (
    handoff === null ||
    pending.detail.generation !== pending.handoff.executionGeneration ||
    !handoffsMatch(handoff, pending.handoff)
  ) {
    return RECOVERY_COMPLETE;
  }
  const identity = handoffIdentity(pending);
  const claimed = dependencies.store.claimRestartHandoff(
    pending.userId,
    identity,
    dependencies.now(),
  );
  if (claimed === undefined) {
    return RECOVERY_COMPLETE;
  }
  const claimedHandoff = claimed.restartHandoff;
  if (
    claimed.generation !== identity.generation ||
    claimedHandoff === null ||
    !handoffsMatch(claimedHandoff, pending.handoff)
  ) {
    restoreClaim(dependencies, identity);
    return RECOVERY_COMPLETE;
  }
  const queued = (): RestartRecoveryResult => RECOVERY_RETRY_LAUNCH;
  let launched: boolean;
  try {
    launched = dependencies.launch(
      claimed,
      credential,
      pending.userId,
      claimedHandoff.operation,
    );
  } catch (error) {
    dependencies.store.failRestartHandoff(
      pending.userId,
      identity,
      restartFailureMessage(error),
      dependencies.now(),
    );
    dependencies.notify(pending.userId, pending.detail.id);
    return RECOVERY_COMPLETE;
  }

  if (!launched) {
    restoreClaim(dependencies, identity);
    return queued();
  }
  dependencies.notify(pending.userId, pending.detail.id);
  return RECOVERY_COMPLETE;
}

const INVALID_RESTART_HANDOFF_ERROR =
  "Session failed: Stored restart handoff is invalid";

function failInvalid(
  dependencies: SessionRestartRecoveryDependencies,
  runnerId?: string,
): void {
  for (const invalid of dependencies.store.invalidRestartHandoffs(runnerId)) {
    if (
      dependencies.store.failInvalidRestartHandoff(
        invalid,
        INVALID_RESTART_HANDOFF_ERROR,
        dependencies.now(),
      )
    ) {
      dependencies.notify(invalid.userId, invalid.sessionId);
    }
  }
}

export function recoverSessionRestartHandoffs(
  dependencies: SessionRestartRecoveryDependencies,
  runnerId?: string,
): Promise<RestartRecoveryResult> {
  failInvalid(dependencies, runnerId);
  return Promise.allSettled(
    dependencies.store
      .pendingRestartHandoffs(runnerId)
      .map((pending) => recoverOne(dependencies, pending)),
  ).then((results) => {
    const recovered = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    return {
      pendingCredentials:
        results.some((result) => result.status === "rejected") ||
        recovered.some(({ pendingCredentials }) => pendingCredentials),
      pendingLaunches: recovered.some(({ pendingLaunches }) => pendingLaunches),
    };
  });
}
