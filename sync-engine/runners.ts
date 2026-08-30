import { randomBytes } from "node:crypto";
import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import { RUNNER_INSTALLER_PATH } from "../shared/routes.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { readBoundedTrimmedString } from "../shared/validation.ts";
import { isWorkspaceId } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import { scopedCollectionForUser } from "./authenticated-scoped-collection.ts";
import { runNoncriticalDatabaseWrite } from "./database-write-resilience.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
} from "./http.ts";
import type { OAuthDependencies } from "./oauth.ts";
import { setOwnedDefault } from "./owned-default.ts";
import { requestWorkspaceId } from "./request-workspace.ts";
import type {
  FinalizedRunnerActivationOperations,
  RunnerActivationLifecycleOperations,
} from "./runner-activation-operations.ts";
import { quoteShellValue, renderRunnerInstaller } from "./runner-installer.ts";
import { settleActivationLifecycleParameters } from "./runner-registration-finalization.ts";
import type {
  FinalizedRunnerActivationParameters,
  RunnerLifecycleParameters,
} from "./runner-registration-parameters.ts";
import {
  createRunnerStore,
  type RunnerConnection,
  type RunnerMetadata,
  type RunnerPage,
  type RunnerRegistrationFence,
  type RunnerRegistrationPrepareOptions,
  type RunnerStore,
} from "./runner-store.ts";
import { updateAuthenticatedConnectionScopes } from "./scoped-collection.ts";
import {
  runnerAvailabilityAt,
  type SessionRunnerAvailability,
} from "./session-runner-availability.ts";

const RUNNER_TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const MACHINE_FINGERPRINT_PATTERN = /^[A-Za-z\d._:-]{8,200}$/u;
const MACHINE_VALUE_PATTERN = /^[A-Za-z\d._ -]{1,100}$/u;

type RunnerRemovedListener = (
  userId: string,
  runnerId: string,
) => Promise<void> | void;

type RunnerRemovingListener = (userId: string, runnerId: string) => void;

type RunnerParentReportListener = (
  userId: string,
  report: Readonly<{
    disposition: "deferred" | "delivered" | "promoted" | "terminal";
    parentId: string;
  }>,
) => void;

interface RunnerRemovalListeners {
  readonly removed: RunnerRemovedListener;
  readonly removing: RunnerRemovingListener;
}

function detachRemovedListeners(
  listeners: ReadonlySet<RunnerRemovalListeners>,
  userId: string,
  runnerId: string,
): void {
  for (const listener of listeners) {
    detachRemovedListener(listener.removed, userId, runnerId);
  }
}

function detachRemovedListener(
  removed: RunnerRemovedListener,
  userId: string,
  runnerId: string,
): void {
  try {
    void Promise.resolve(removed(userId, runnerId)).catch(() => {
      // Removal is committed; asynchronous cleanup cannot change its outcome.
    });
  } catch {
    // Removal is committed; cleanup failures cannot change its outcome.
  }
}

interface RunnerDependencies extends Pick<
  OAuthDependencies,
  "database" | "now" | "randomId" | "randomToken"
> {
  readonly generateActivationId?: () => string;
  readonly onRemoved?: RunnerRemovedListener;
  readonly store?: RunnerStore;
}

interface ConnectedRunner {
  readonly connection: RunnerConnection;
  readonly userId: string;
}

export interface RunnerRegistrationProposal {
  readonly activationId: string;
  finalize(receipt: string): RunnerRegistrationActivation;
  prepare(restartId?: string): RunnerRegistrationCommit;
  readonly replaysSettledFinalization?: boolean;
  readonly runnerId: string;
}

export interface RunnerActivationReceiptValidation {
  readonly activationId: string;
  readonly connection: RunnerConnection;
  readonly lifecycle: "ordinary" | "restart";
  readonly lifecycleSettled: boolean;
  readonly phase: "finalized" | "prepared";
  readonly restartId: string | undefined;
}

type RunnerRegistrationActivation =
  | {
      readonly connected: ConnectedRunner;
      readonly status: "activated";
    }
  | { readonly status: "registration_changed" };

type RunnerRegistrationCommit =
  | {
      readonly activationReceipt: string;
      readonly connected: ConnectedRunner;
      readonly status: "registered";
    }
  | { readonly status: "registration_changed" };

interface RunnerOptionQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
}

export interface RunnerIntegration
  extends
    RunnerActivationLifecycleOperations,
    FinalizedRunnerActivationOperations<
      ConnectedRunner | undefined,
      readonly []
    > {
  collection(request: Request): Response;
  connect(token: string, metadata: RunnerMetadata): ConnectedRunner | undefined;
  disconnected(runner: RunnerConnection): void;
  installer(request: Request): Response;
  listForUser(userId: string, workspaceId?: string): readonly RunnerSummary[];
  listOnlineForUser(
    userId: string,
    query: RunnerOptionQuery,
    workspaceId?: string,
  ): RunnerPage;
  onParentReport(listener: RunnerParentReportListener): void;
  onRemoved(listener: RunnerRemovedListener): void;
  onRemoving(listener: RunnerRemovingListener): void;
  onlineForUser(userId: string, workspaceId?: string): readonly RunnerSummary[];
  preflightRegistration(
    token: string,
    metadata: RunnerMetadata,
    activationId?: string,
  ): RunnerRegistrationProposal | undefined;
  receiptState(
    token: string,
    metadata: RunnerMetadata,
    receipt: string,
  ): RunnerActivationReceiptValidation | undefined;
  remove(request: Request, runnerId: string): Promise<Response>;
  runnerIsAvailable: SessionRunnerAvailability;
  runnerAccount(request: Request): { readonly userId: string } | undefined;
  runnerToken(request: Request): string | undefined;
  seen(runner: RunnerConnection): void;
  setDefault(request: Request, runnerId: string): Response;
  setScopes(request: Request, runnerId: string): Promise<Response>;
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

function createRunnerToken(randomToken: () => string): string {
  const token = `qmr_${randomToken()}`;

  if (!RUNNER_TOKEN_PATTERN.test(token)) {
    throw new Error("The runner token generator returned an invalid token");
  }

  return token;
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ") !== true) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length);
  return RUNNER_TOKEN_PATTERN.test(token) ? token : undefined;
}

function normalizeMachineValue(value: unknown): string | undefined {
  const normalized = readBoundedTrimmedString(value, 100);
  return normalized !== undefined && MACHINE_VALUE_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

export function readRunnerMetadata(value: unknown): RunnerMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const architecture = normalizeMachineValue(value["architecture"]);
  const machineFingerprint = value["machineId"];
  const name = normalizeMachineValue(value["name"]);
  const platform = normalizeMachineValue(value["platform"]);

  if (
    architecture === undefined ||
    typeof machineFingerprint !== "string" ||
    !MACHINE_FINGERPRINT_PATTERN.test(machineFingerprint) ||
    name === undefined ||
    platform === undefined
  ) {
    return undefined;
  }

  return { architecture, machineFingerprint, name, platform };
}

export function createRunnerIntegration(
  auth: GoogleAuth,
  dependencies: RunnerDependencies = {},
): RunnerIntegration {
  const now = dependencies.now ?? Date.now;
  const removalListeners = new Set<RunnerRemovalListeners>();
  const parentReportListeners = new Set<RunnerParentReportListener>();
  if (dependencies.onRemoved !== undefined) {
    removalListeners.add({
      removed: dependencies.onRemoved,
      removing: () => undefined,
    });
  }
  const randomToken = dependencies.randomToken ?? defaultRandomToken;
  const store =
    dependencies.store ??
    createRunnerStore(
      dependencies.database ?? createDatabase(":memory:"),
      dependencies.randomId ?? createUuidV7,
      dependencies.generateActivationId ?? createUuidV7,
      (userId, report) => {
        for (const listener of parentReportListeners) listener(userId, report);
      },
    );
  const runnerIsAvailable = runnerAvailabilityAt(store, now);
  function collection(request: Request): Response {
    return withAuthenticatedUser(auth, request, (user) =>
      collectionForUser(request, user),
    );
  }

  function connect(
    token: string,
    metadata: RunnerMetadata,
  ): ConnectedRunner | undefined {
    const proposal = preflightRegistration(token, metadata, createUuidV7());
    if (proposal === undefined) {
      return undefined;
    }
    const committed = proposal.prepare();
    if (committed.status !== "registered") {
      return undefined;
    }
    const activated = proposal.finalize(committed.activationReceipt);
    if (activated.status !== "activated") {
      return undefined;
    }
    return store.registration.settleActivationLifecycle(
      proposal.activationId,
      "ordinary",
    )
      ? activated.connected
      : undefined;
  }

  function setOnline(runner: RunnerConnection, online: boolean): void {
    runNoncriticalDatabaseWrite(store.database, () => {
      store.setOnline(runner.id, runner.userId, now(), online);
    });
  }

  function disconnected(runner: RunnerConnection): void {
    setOnline(runner, false);
  }

  function list(
    userId: string,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    return store.list(userId, now(), workspaceId);
  }

  function listForUser(
    userId: string,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    return list(userId, workspaceId);
  }

  function listOnlineForUser(
    userId: string,
    query: RunnerOptionQuery,
    workspaceId?: string,
  ): RunnerPage {
    return store.listOnline(
      userId,
      now(),
      query.offset,
      query.limit,
      query.search,
      workspaceId,
    );
  }

  function onParentReport(listener: RunnerParentReportListener): void {
    parentReportListeners.add(listener);
  }

  function onRemoved(listener: RunnerRemovedListener): void {
    removalListeners.add({
      removed: listener,
      removing: () => undefined,
    });
  }

  function onRemoving(listener: RunnerRemovingListener): void {
    removalListeners.add({
      removed: () => undefined,
      removing: listener,
    });
  }

  function onlineForUser(
    ...selection: readonly [string, string?]
  ): readonly RunnerSummary[] {
    return list(...selection).filter(({ status }) => status === "online");
  }

  function preflightRegistration(
    token: string,
    metadata: RunnerMetadata,
    activationId = createUuidV7(),
  ): RunnerRegistrationProposal | undefined {
    const result = store.registration.preflight(token, metadata, activationId);
    if (result.status !== "ready") {
      return undefined;
    }
    const registration = result.registration;
    let activated: RunnerRegistrationActivation | undefined;
    let committed: RunnerRegistrationCommit | undefined;
    let fence: RunnerRegistrationFence | undefined;
    return {
      activationId: registration.activationId,
      prepare: (restartId) => {
        const lifecycle = restartId === undefined ? "ordinary" : "restart";
        if (
          committed?.status === "registered" &&
          fence !== undefined &&
          store.registration.fenceIsCurrent(fence)
        ) {
          return committed;
        }
        if (activated?.status === "activated") {
          return committed ?? { status: "registration_changed" as const };
        }
        committed = (() => {
          const preparation: RunnerRegistrationPrepareOptions = {
            lifecycle,
            now: now(),
            ...(restartId === undefined ? {} : { restartId }),
          };
          const result = store.registration.commit(registration, preparation);
          if (result.status !== "registered") {
            fence = undefined;
            return result;
          }
          const connection = result.registration.connection;
          fence = result.registration.fence;
          activated = undefined;
          return {
            activationReceipt: store.registration.receipt(fence),
            connected: { connection, userId: connection.userId },
            status: "registered" as const,
          };
        })();
        return committed;
      },
      finalize: (receipt) => {
        if (activated?.status === "activated") {
          return activated;
        }
        if (fence === undefined) {
          return { status: "registration_changed" as const };
        }
        const applied = store.registration.finalizeRegistration(fence, {
          now: now(),
          receipt,
        });
        activated =
          applied.status === "activated"
            ? {
                connected: {
                  connection: applied.connection,
                  userId: applied.connection.userId,
                },
                status: "activated" as const,
              }
            : applied;
        fence = undefined;
        return activated;
      },
      replaysSettledFinalization:
        registration.source.activationPhase === "finalized" &&
        registration.source.activationLifecycleSettled,
      runnerId: registration.target.id,
    };
  }

  function installer(request: Request): Response {
    return request.method === "GET"
      ? serveInstaller(request)
      : createMethodNotAllowedResponse("GET");
  }

  async function remove(request: Request, runnerId: string): Promise<Response> {
    if (request.method !== "DELETE") {
      return createMethodNotAllowedResponse("DELETE");
    }
    return await Promise.resolve(
      withAuthenticatedUser(auth, request, (user) => {
        if (!store.exists(user.id, runnerId)) {
          return createApiError("not_found", 404);
        }
        const removed = store.remove(user.id, runnerId, now());
        if (!removed) {
          return createApiError("not_found", 404);
        }
        for (const { removing } of removalListeners) {
          removing(user.id, runnerId);
        }
        notifyRemoved(user.id, runnerId);
        return createNoContentResponse();
      }),
    );
  }

  function notifyRemoved(userId: string, runnerId: string): void {
    setTimeout(detachRemovedListeners, 0, removalListeners, userId, runnerId);
  }

  function receiptState(
    ...parameters: readonly [string, RunnerMetadata, string]
  ): RunnerActivationReceiptValidation | undefined {
    return store.registration.receiptState(...parameters);
  }

  function settleActivationLifecycle(
    ...parameters: RunnerLifecycleParameters
  ): boolean {
    return settleActivationLifecycleParameters(
      store.registration.settleActivationLifecycle.bind(store.registration),
      parameters,
    );
  }

  function touchFinalizedActivation(
    ...[token, metadata, receipt]: FinalizedRunnerActivationParameters
  ): ConnectedRunner | undefined {
    const connection = store.registration.touchFinalizedActivation(
      token,
      metadata,
      receipt,
      now(),
    );
    return connection === undefined
      ? undefined
      : { connection, userId: connection.userId };
  }

  function runnerAccount(
    request: Request,
  ): { readonly userId: string } | undefined {
    const token = readBearerToken(request);
    const connection =
      token === undefined ? undefined : store.authenticate(token);
    return connection === undefined ? undefined : { userId: connection.userId };
  }

  function runnerToken(request: Request): string | undefined {
    const token = readBearerToken(request);
    return token !== undefined && store.hasActiveToken(token)
      ? token
      : undefined;
  }

  function seen(runner: RunnerConnection): void {
    setOnline(runner, true);
  }

  function setDefault(request: Request, runnerId: string): Response {
    return setOwnedDefault(request, auth, (userId) => {
      return store.setDefault(userId, runnerId, now());
    });
  }

  async function setScopes(
    request: Request,
    runnerId: string,
  ): Promise<Response> {
    return updateAuthenticatedConnectionScopes(
      request,
      (action) => withAuthenticatedUser(auth, request, action),
      (userId, workspaceIds) =>
        store.setScopes(userId, runnerId, workspaceIds, now()),
    );
  }

  function collectionForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Response {
    return scopedCollectionForUser({
      create: () => createSetup(request, user),
      key: "runners",
      read: (userId, workspaceId) => store.list(userId, now(), workspaceId),
      request,
      user,
      validate: (userId, workspaceId) =>
        store.workspaceScopesAreValid(userId, [workspaceId]),
    });
  }

  function serveInstaller(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (
      token === null ||
      !RUNNER_TOKEN_PATTERN.test(token) ||
      !store.hasActiveToken(token)
    ) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": "text/x-shellscript; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });

    if (url.searchParams.get("download") === "1") {
      headers.set(
        "content-disposition",
        'attachment; filename="q-mush-runner-install.sh"',
      );
    }

    return new Response(renderRunnerInstaller(url.origin, token), { headers });
  }

  function createSetup(request: Request, user: AuthenticatedUser): Response {
    const workspaceId = requestWorkspaceId(request);
    const workspaceIds = workspaceId === null ? undefined : [workspaceId];
    if (
      workspaceIds !== undefined &&
      (!isWorkspaceId(workspaceId) ||
        !store.workspaceScopesAreValid(user.id, workspaceIds))
    ) {
      return createApiError("invalid_scope", 409);
    }
    const token = createRunnerToken(randomToken);
    const runner = store.create(user.id, token, now(), workspaceIds);
    const installerUrl = new URL(RUNNER_INSTALLER_PATH, request.url);
    installerUrl.searchParams.set("token", token);
    const downloadUrl = new URL(installerUrl);
    downloadUrl.searchParams.set("download", "1");

    return createJsonResponse(
      {
        runner,
        setup: {
          command: `curl -fsSL ${quoteShellValue(installerUrl.toString())} | sh`,
          downloadUrl: `${downloadUrl.pathname}${downloadUrl.search}`,
        },
      },
      201,
    );
  }

  return {
    collection,
    connect,
    disconnected,
    installer,
    listForUser,
    listOnlineForUser,
    onParentReport,
    onRemoved,
    onRemoving,
    onlineForUser,
    preflightRegistration,
    receiptState,
    remove,
    runnerAccount,
    runnerIsAvailable,
    runnerToken,
    seen,
    setDefault,
    setScopes,
    settleActivationLifecycle,
    touchFinalizedActivation,
  };
}
