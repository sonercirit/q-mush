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

interface SessionRestartRecoveryStore {
  readonly claimRestartHandoff: (
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ) => AgentSessionDetail | undefined;
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

async function recoverOne(
  dependencies: SessionRestartRecoveryDependencies,
  pending: PendingRestartSession,
): Promise<RestartRecoveryResult> {
  if (
    pending.handoff.requestedBy === "runner" &&
    pending.handoff.restartId !== dependencies.restartId
  ) {
    return { pendingCredentials: false, pendingLaunches: false };
  }
  if (
    !sessionRunnerIsAvailable(
      dependencies.runnerIsAvailable,
      pending.userId,
      pending.detail,
    )
  ) {
    return { pendingCredentials: false, pendingLaunches: false };
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
    return { pendingCredentials: false, pendingLaunches: false };
  }
  const identity = handoffIdentity(pending);
  const claimed = dependencies.store.claimRestartHandoff(
    pending.userId,
    identity,
    dependencies.now(),
  );
  if (claimed === undefined) {
    return { pendingCredentials: false, pendingLaunches: false };
  }
  const claimedHandoff = claimed.restartHandoff;
  if (
    claimed.generation !== identity.generation ||
    claimedHandoff === null ||
    !handoffsMatch(claimedHandoff, pending.handoff)
  ) {
    restoreClaim(dependencies, identity);
    return { pendingCredentials: false, pendingLaunches: false };
  }
  const queued = (): RestartRecoveryResult => ({
    pendingCredentials: false,
    pendingLaunches: true,
  });
  let launched: boolean;
  try {
    launched = dependencies.launch(
      claimed,
      credential,
      pending.userId,
      claimedHandoff.operation,
    );
  } catch {
    restoreClaim(dependencies, identity);
    return queued();
  }

  if (!launched) {
    restoreClaim(dependencies, identity);
    return queued();
  }
  dependencies.notify(pending.userId, pending.detail.id);
  return { pendingCredentials: false, pendingLaunches: false };
}

export function recoverSessionRestartHandoffs(
  dependencies: SessionRestartRecoveryDependencies,
  runnerId?: string,
): Promise<RestartRecoveryResult> {
  return Promise.all(
    dependencies.store
      .pendingRestartHandoffs(runnerId)
      .map((pending) => recoverOne(dependencies, pending)),
  ).then((results) => ({
    pendingCredentials: results.some(
      ({ pendingCredentials }) => pendingCredentials,
    ),
    pendingLaunches: results.some(({ pendingLaunches }) => pendingLaunches),
  }));
}
