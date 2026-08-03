import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createRealtimeIntegration,
  type QmushWebSocketData,
} from "../../sync-engine/realtime.ts";
import type { RunnerIntegration } from "../../sync-engine/runners.ts";
import type { SessionRealtimeCommands } from "../../sync-engine/session-realtime-commands.ts";
import type { SessionIntegration } from "../../sync-engine/sessions.ts";
import {
  emptyTestModelCatalog,
  REALTIME_TEST_SESSION_DETAIL,
  realtimeTestHistoryPage,
  realtimeTestPendingInput,
} from "./realtime-session-fixture.ts";

export const REALTIME_TEST_USER: AuthenticatedUser = {
  email: "mush@example.com",
  id: "user-1",
  name: "Mush",
  picture: "https://example.test/avatar.png",
};

export class RealtimeUpgradeServer {
  data: QmushWebSocketData | undefined;

  upgrade(
    _request: Request,
    options: { readonly data: QmushWebSocketData },
  ): boolean {
    this.data = options.data;
    return true;
  }
}

export function realtimeTestAuth(user: AuthenticatedUser | null): GoogleAuth {
  return {
    authenticatedUser: () => user,
    revalidateUser: (_request, expectedUserId) =>
      user?.id === expectedUserId ? user : null,
    begin: () => new Response(),
    complete: () => Promise.resolve(new Response()),
    logout: () => new Response(),
    session: () => new Response(),
  };
}

export type RealtimeRunnerOverrides = Partial<
  Pick<
    RunnerIntegration,
    | "connect"
    | "disconnected"
    | "preflightRegistration"
    | "receiptState"
    | "runnerToken"
    | "seen"
    | "settleActivationLifecycle"
    | "touchFinalizedActivation"
  >
>;

type RealtimeRegistrationProposal = NonNullable<
  ReturnType<RunnerIntegration["preflightRegistration"]>
>;

interface RealtimeReceiptStateFixture {
  activationId: string;
  lifecycle: "ordinary" | "restart";
  lifecycleSettled: boolean;
  phase: "finalized" | "prepared";
  restartId: string | undefined;
}

function receiptStateFixture(
  initialPhase: "finalized" | "prepared",
  initialScope: Readonly<{
    lifecycle: "ordinary" | "restart";
    restartId: string | undefined;
  }>,
): RealtimeReceiptStateFixture {
  return {
    activationId: "test-activation-id",
    lifecycle: initialScope.lifecycle,
    lifecycleSettled: false,
    phase: initialPhase,
    restartId: initialScope.restartId,
  };
}

function receiptValidation(
  state: RealtimeReceiptStateFixture,
  connection: Readonly<{ id: string; userId: string }>,
): ReturnType<RunnerIntegration["receiptState"]> {
  return {
    activationId: state.activationId,
    connection,
    lifecycle: state.lifecycle,
    lifecycleSettled: state.lifecycleSettled,
    phase: state.phase,
    restartId: state.restartId,
  };
}

export function realtimeRunnerReceiptState(
  overrides: Partial<RealtimeReceiptStateFixture> = {},
): ReturnType<RunnerIntegration["receiptState"]> {
  return receiptValidation(
    {
      ...receiptStateFixture("finalized", {
        lifecycle: "ordinary",
        restartId: undefined,
      }),
      ...overrides,
    },
    realtimeRunnerConnection().connection,
  );
}

function realtimeRunnerRegistrationProposal(
  finalize: RealtimeRegistrationProposal["finalize"],
): RealtimeRegistrationProposal {
  return {
    activationId: "test-activation-id",
    finalize,
    prepare: () => ({
      activationReceipt: "test-activation-receipt",
      connected: realtimeRunnerConnection(),
      status: "registered",
    }),
    runnerId: "runner-1",
  };
}

export function proposedRunnerRealtimeTestIntegration(
  finalize: RealtimeRegistrationProposal["finalize"],
  runnerOverrides: RealtimeRunnerOverrides = {},
) {
  return connectedRunnerRealtimeTestIntegration(
    {},
    {
      ...runnerOverrides,
      preflightRegistration: () => realtimeRunnerRegistrationProposal(finalize),
    },
  );
}

function proposalForRealtime(
  proposal: RealtimeRegistrationProposal,
  state: RealtimeReceiptStateFixture,
  finalizedReceipts: Set<string>,
): RealtimeRegistrationProposal {
  state.activationId = proposal.activationId;
  return {
    ...proposal,
    finalize: (receipt) => {
      const finalized = proposal.finalize(receipt);
      if (finalized.status === "activated") {
        state.phase = "finalized";
        state.lifecycleSettled = false;
        finalizedReceipts.add(receipt);
      }
      return finalized;
    },
    prepare: (restartId) => {
      const prepared = proposal.prepare(restartId);
      if (prepared.status === "registered") {
        state.lifecycle = restartId === undefined ? "ordinary" : "restart";
        state.restartId = restartId;
        state.lifecycleSettled = false;
      }
      return prepared;
    },
  };
}

function realtimeTestRunners(
  token: string | undefined,
  overrides: RealtimeRunnerOverrides = {},
): RunnerIntegration {
  return {
    collection: () => new Response(),
    connect: () => undefined,
    disconnected: () => undefined,
    installer: () => new Response(),
    listForUser: () => [],
    listOnlineForUser: () => ({ items: [], totalItems: 0 }),
    onRemoved: () => undefined,
    onRemoving: () => undefined,
    onlineForUser: () => [],
    preflightRegistration: () => undefined,
    receiptState: () => undefined,
    remove: () => Promise.resolve(new Response()),
    runnerIsAvailable: () => false,
    runnerToken: () => token,
    seen: () => undefined,
    setDefault: () => new Response(),
    setScopes: () => Promise.resolve(new Response()),
    settleActivationLifecycle: () => true,
    touchFinalizedActivation: () => undefined,
    ...overrides,
  };
}

class RealtimeTestSessionCommands implements SessionRealtimeCommands {
  answerQuestionsForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  cancelPendingInputForUser() {
    return {
      detail: REALTIME_TEST_SESSION_DETAIL,
      input: realtimeTestPendingInput(),
    };
  }

  compactForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  compactAndContinueForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  continueForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  createForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  forkForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  spawnForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  historyForUser() {
    return realtimeTestHistoryPage();
  }

  messageForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  modelsForUser() {
    return emptyTestModelCatalog();
  }

  pendingInputForUser() {
    return REALTIME_TEST_SESSION_DETAIL;
  }

  previewToolUpdateForUser() {
    return Promise.resolve({
      cacheDisposition: "preserved" as const,
      currentGeneration: 0,
      tools: REALTIME_TEST_SESSION_DETAIL.tools,
      warning: null,
    });
  }

  detailForUser() {
    return REALTIME_TEST_SESSION_DETAIL;
  }

  reassignForUser() {
    return REALTIME_TEST_SESSION_DETAIL;
  }

  setAutoCompactionForUser() {
    return REALTIME_TEST_SESSION_DETAIL;
  }

  stopForUser() {
    return REALTIME_TEST_SESSION_DETAIL;
  }

  summariesForUser() {
    return [REALTIME_TEST_SESSION_DETAIL];
  }

  updateProviderForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }

  updateToolsForUser() {
    return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
  }
}

export type RealtimeSessionOverrides = Partial<
  Pick<
    SessionIntegration,
    | "completeRunnerCommand"
    | "deliverRunnerCommands"
    | "detailForUser"
    | "drainRunner"
    | "listForUser"
    | "onChange"
    | "pendingQuestionForUser"
    | "pendingRunnerRestart"
    | "replaceRunnerConnection"
    | "runnerConnected"
    | "runnerConnectionGeneration"
    | "runnerDisconnected"
    | "runnerRestartReady"
  >
>;

export function realtimeTestSessions(
  overrides: RealtimeSessionOverrides = {},
): SessionIntegration {
  return {
    collection: () => Promise.resolve(new Response()),
    compact: () => Promise.resolve(new Response()),
    compaction: () => Promise.resolve(new Response()),
    completeRunnerCommand: () => false,
    continue: () => Promise.resolve(new Response()),
    deliverRunnerCommands: () => true,
    detailForUser: () => undefined,
    directories: () => Promise.resolve(new Response()),
    drain: () => Promise.resolve(),
    drainRunner: () => Promise.resolve(),
    item: () => new Response(),
    listForUser: () => [],
    message: () => Promise.resolve(new Response()),
    models: () => Promise.resolve(new Response()),
    onChange: () => undefined,
    openRouterProviders: () => Promise.resolve(new Response()),
    pendingQuestionForUser: () => null,
    prepareFinalShutdown: () => Promise.resolve(),
    pendingRunnerRestart: () => ({ status: "none" }),
    realtimeCommands: new RealtimeTestSessionCommands(),
    reassign: () => Promise.resolve(new Response()),
    replaceRunnerConnection: () => undefined,
    runnerConnected: () => undefined,
    runnerConnectionGeneration: () => 0,
    runnerDisconnected: () => undefined,
    runnerRestartReady: () => undefined,
    runnerRemoved: () => Promise.resolve(),
    stop: () => Promise.resolve(new Response()),
    streamRunnerCommand: () => false,
    ...overrides,
  };
}

interface RealtimeRunnerLifecycleRecord {
  readonly connected: string[];
  readonly disconnected: string[];
}

export function realtimeRunnerLifecycle(
  record: RealtimeRunnerLifecycleRecord,
): Pick<RealtimeSessionOverrides, "runnerConnected" | "runnerDisconnected"> {
  return {
    runnerConnected: (runnerId) => {
      record.connected.push(runnerId);
    },
    runnerDisconnected: (runnerId) => {
      record.disconnected.push(runnerId);
    },
  };
}

export function runnerRestartGate(restartId: string) {
  return {
    requestedBy: "runner" as const,
    restartId,
    status: "pending" as const,
  };
}

export function realtimeRunnerConnection(
  runnerId = "runner-1",
  userId = REALTIME_TEST_USER.id,
): Readonly<{
  connection: Readonly<{ id: string; userId: string }>;
  userId: string;
}> {
  return { connection: { id: runnerId, userId }, userId };
}

type RealtimeDependencies = Parameters<typeof createRealtimeIntegration>[0];

export function configuredRealtimeTestIntegration(
  overrides: Partial<RealtimeDependencies> = {},
): ReturnType<typeof createRealtimeIntegration> {
  return createRealtimeIntegration({
    auth: realtimeTestAuth(null),
    hub: new RealtimeHub(),
    runnerVersion: "runner-version",
    runners: realtimeTestRunners(undefined),
    sessions: realtimeTestSessions(),
    ...overrides,
  });
}

export function createRealtimeTestIntegration(
  selectedAuth: GoogleAuth,
  options: {
    readonly runnerOverrides?: RealtimeRunnerOverrides;
    readonly sessionOverrides?: RealtimeSessionOverrides;
    readonly token?: string;
  } = {},
): ReturnType<typeof createRealtimeIntegration> {
  return configuredRealtimeTestIntegration({
    auth: selectedAuth,
    runners: realtimeTestRunners(options.token, options.runnerOverrides),
    sessions: realtimeTestSessions(options.sessionOverrides),
  });
}

export interface RunnerReceiptScope {
  readonly lifecycle: "ordinary" | "restart";
  readonly restartId: string | undefined;
}

export const ORDINARY_RUNNER_RECEIPT_SCOPE: RunnerReceiptScope = {
  lifecycle: "ordinary",
  restartId: undefined,
};

export function connectedRunnerRealtimeTestIntegration(
  sessionOverrides: RealtimeSessionOverrides = {},
  runnerOverrides: RealtimeRunnerOverrides = {},
  finalizedReceipts = new Set<string>(),
  receiptScope: RunnerReceiptScope = ORDINARY_RUNNER_RECEIPT_SCOPE,
): ReturnType<typeof createRealtimeIntegration> {
  const fallback = realtimeRunnerConnection();
  const token = "qmr_runner-token";
  const selected =
    runnerOverrides.connect?.(token, {
      architecture: "x64",
      machineFingerprint: "test-machine",
      name: "runner",
      platform: "linux",
    }) ?? fallback;
  const receiptState = receiptStateFixture("prepared", receiptScope);
  const proposal: NonNullable<
    RealtimeRunnerOverrides["preflightRegistration"]
  > = (_token, _metadata, activationId = "test-activation-id") => ({
    activationId,
    prepare: () => ({
      activationReceipt: "test-activation-receipt",
      connected: selected,
      status: "registered" as const,
    }),
    finalize: () => ({
      connected: selected,
      status: "activated" as const,
    }),
    runnerId: selected.connection.id,
  });
  const preflight = runnerOverrides.preflightRegistration ?? proposal;
  const settleLifecycle =
    runnerOverrides.settleActivationLifecycle ?? (() => true);
  const realtime = createRealtimeTestIntegration(realtimeTestAuth(null), {
    runnerOverrides: {
      ...runnerOverrides,
      connect: () => selected,
      preflightRegistration: (registrationToken, metadata, activationId) => {
        const candidate = preflight(registrationToken, metadata, activationId);
        if (candidate === undefined) {
          return undefined;
        }
        return proposalForRealtime(candidate, receiptState, finalizedReceipts);
      },
      settleActivationLifecycle: (activationId, lifecycle, restartId) => {
        const settled = settleLifecycle(activationId, lifecycle, restartId);
        receiptState.lifecycleSettled = settled;
        return settled;
      },
      receiptState:
        runnerOverrides.receiptState ??
        ((_token, _metadata, receipt) => {
          if (
            receipt === "test-activation-receipt" ||
            receipt === "restart-prepared-retry"
          ) {
            const finalized = finalizedReceipts.has(receipt);
            return receiptValidation(
              {
                ...receiptState,
                lifecycle:
                  receipt === "restart-prepared-retry" && !finalized
                    ? "restart"
                    : receiptState.lifecycle,
                phase: finalized ? "finalized" : receiptState.phase,
                restartId:
                  receipt === "restart-prepared-retry" && !finalized
                    ? receipt
                    : receiptState.restartId,
              },
              selected.connection,
            );
          }
          return undefined;
        }),
      touchFinalizedActivation:
        runnerOverrides.touchFinalizedActivation ?? (() => selected),
    },
    sessionOverrides,
    token,
  });
  return realtime;
}

export function recreatedRunnerRealtimeTestIntegration(
  sessions: SessionIntegration,
  finalizedReceipts: ReadonlySet<string> = new Set(),
  receiptScope: RunnerReceiptScope = ORDINARY_RUNNER_RECEIPT_SCOPE,
): ReturnType<typeof createRealtimeIntegration> {
  const connection = realtimeRunnerConnection();
  const initialPhase: "finalized" | "prepared" = finalizedReceipts.has(
    "test-activation-receipt",
  )
    ? "finalized"
    : "prepared";
  let activationPhase = initialPhase;
  let lifecycle: "ordinary" | "restart" = receiptScope.lifecycle;
  let restartId = receiptScope.restartId;
  let lifecycleSettled = false;

  return configuredRealtimeTestIntegration({
    runners: realtimeTestRunners("qmr_runner-token", {
      connect: () => connection,
      preflightRegistration: () => ({
        activationId: "test-activation-id",
        finalize: () => {
          activationPhase = "finalized";
          return {
            connected: connection,
            status: "activated",
          };
        },
        prepare: (preparedRestartId) => {
          lifecycle = preparedRestartId === undefined ? "ordinary" : "restart";
          restartId = preparedRestartId;
          return {
            activationReceipt: "test-activation-receipt",
            connected: connection,
            status: "registered",
          };
        },
        runnerId: connection.connection.id,
      }),
      settleActivationLifecycle: () => {
        lifecycleSettled = true;
        return true;
      },
      touchFinalizedActivation: () => connection,
      receiptState: (_token, _metadata, receipt) =>
        receipt === "test-activation-receipt"
          ? {
              activationId: "test-activation-id",
              connection: connection.connection,
              lifecycle,
              lifecycleSettled,
              phase: activationPhase,
              restartId,
            }
          : undefined,
    }),
    sessions,
  });
}
