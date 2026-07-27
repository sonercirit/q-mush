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
  RunnerStore,
  type RunnerConnection,
  type RunnerMetadata,
  type RunnerPage,
  type RunnerRegistrationFence,
  type RunnerRegistrationPrepareOptions,
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

interface RunnerRemovalListeners {
  readonly removed: RunnerRemovedListener;
  readonly removing: RunnerRemovingListener;
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

class DrizzleRunnerIntegration implements RunnerIntegration {
  readonly #auth: GoogleAuth;
  readonly #now: () => number;
  readonly #removalListeners = new Set<RunnerRemovalListeners>();
  readonly #randomToken: () => string;
  readonly #runnerIsAvailable: SessionRunnerAvailability;
  readonly #store: RunnerStore;

  constructor(auth: GoogleAuth, dependencies: RunnerDependencies) {
    this.#auth = auth;
    this.#now = dependencies.now ?? Date.now;
    if (dependencies.onRemoved !== undefined) {
      this.#removalListeners.add({
        removed: dependencies.onRemoved,
        removing: () => undefined,
      });
    }
    this.#randomToken = dependencies.randomToken ?? defaultRandomToken;
    this.#store =
      dependencies.store ??
      new RunnerStore(
        dependencies.database ?? createDatabase(":memory:"),
        dependencies.randomId ?? createUuidV7,
        dependencies.generateActivationId ?? createUuidV7,
      );
    this.#runnerIsAvailable = runnerAvailabilityAt(this.#store, this.#now);
  }

  collection(request: Request): Response {
    return withAuthenticatedUser(this.#auth, request, (user) =>
      this.#collectionForUser(request, user),
    );
  }

  connect(
    token: string,
    metadata: RunnerMetadata,
  ): ConnectedRunner | undefined {
    const proposal = this.preflightRegistration(
      token,
      metadata,
      createUuidV7(),
    );
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
    return this.#store.registration.settleActivationLifecycle(
      proposal.activationId,
      "ordinary",
    )
      ? activated.connected
      : undefined;
  }

  #setOnline(runner: RunnerConnection, online: boolean): void {
    this.#store.setOnline(runner.id, runner.userId, this.#now(), online);
  }

  disconnected(runner: RunnerConnection): void {
    this.#setOnline(runner, false);
  }

  #list(userId: string, workspaceId?: string): readonly RunnerSummary[] {
    return this.#store.list(userId, this.#now(), workspaceId);
  }

  listForUser(userId: string, workspaceId?: string): readonly RunnerSummary[] {
    return this.#list(userId, workspaceId);
  }

  listOnlineForUser(
    userId: string,
    query: RunnerOptionQuery,
    workspaceId?: string,
  ): RunnerPage {
    return this.#store.listOnline(
      userId,
      this.#now(),
      query.offset,
      query.limit,
      query.search,
      workspaceId,
    );
  }

  onRemoved(listener: RunnerRemovedListener): void {
    this.#removalListeners.add({
      removed: listener,
      removing: () => undefined,
    });
  }

  onRemoving(listener: RunnerRemovingListener): void {
    this.#removalListeners.add({
      removed: () => undefined,
      removing: listener,
    });
  }

  onlineForUser(
    userId: string,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    return this.#list(userId, workspaceId).filter(
      ({ status }) => status === "online",
    );
  }

  preflightRegistration(
    token: string,
    metadata: RunnerMetadata,
    activationId = createUuidV7(),
  ): RunnerRegistrationProposal | undefined {
    const result = this.#store.registration.preflight(
      token,
      metadata,
      activationId,
    );
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
          this.#store.registration.fenceIsCurrent(fence)
        ) {
          return committed;
        }
        if (activated?.status === "activated") {
          return committed ?? { status: "registration_changed" as const };
        }
        committed = (() => {
          const preparation: RunnerRegistrationPrepareOptions = {
            lifecycle,
            now: this.#now(),
            ...(restartId === undefined ? {} : { restartId }),
          };
          const result = this.#store.registration.commit(
            registration,
            preparation,
          );
          if (result.status !== "registered") {
            fence = undefined;
            return result;
          }
          const connection = result.registration.connection;
          fence = result.registration.fence;
          activated = undefined;
          return {
            activationReceipt: this.#store.registration.receipt(fence),
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
        const applied = this.#store.registration.finalizeRegistration(fence, {
          now: this.#now(),
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

  installer(request: Request): Response {
    return request.method === "GET"
      ? this.#serveInstaller(request)
      : createMethodNotAllowedResponse("GET");
  }

  async remove(request: Request, runnerId: string): Promise<Response> {
    if (request.method !== "DELETE") {
      return createMethodNotAllowedResponse("DELETE");
    }
    return await Promise.resolve(
      withAuthenticatedUser(this.#auth, request, async (user) => {
        if (!this.#store.exists(user.id, runnerId)) {
          return createApiError("not_found", 404);
        }
        const removed = this.#store.remove(user.id, runnerId, this.#now());
        if (!removed) {
          return createApiError("not_found", 404);
        }
        for (const { removing } of this.#removalListeners) {
          removing(user.id, runnerId);
        }
        await this.#notifyRemoved(user.id, runnerId);
        return createNoContentResponse();
      }),
    );
  }

  async #notifyRemoved(userId: string, runnerId: string): Promise<void> {
    await Promise.all(
      [...this.#removalListeners].map(async ({ removed }) => {
        await removed(userId, runnerId);
      }),
    );
  }

  receiptState(
    token: string,
    metadata: RunnerMetadata,
    receipt: string,
  ): RunnerActivationReceiptValidation | undefined {
    return this.#store.registration.receiptState(token, metadata, receipt);
  }

  settleActivationLifecycle(...parameters: RunnerLifecycleParameters): boolean {
    return settleActivationLifecycleParameters(
      this.#store.registration.settleActivationLifecycle.bind(
        this.#store.registration,
      ),
      parameters,
    );
  }

  touchFinalizedActivation(
    ...[token, metadata, receipt]: FinalizedRunnerActivationParameters
  ): ConnectedRunner | undefined {
    const connection = this.#store.registration.touchFinalizedActivation(
      token,
      metadata,
      receipt,
      this.#now(),
    );
    return connection === undefined
      ? undefined
      : { connection, userId: connection.userId };
  }

  runnerIsAvailable: SessionRunnerAvailability = (
    userId,
    runnerId,
    workspaceId,
  ) => this.#runnerIsAvailable(userId, runnerId, workspaceId);

  runnerToken(request: Request): string | undefined {
    const token = readBearerToken(request);
    return token !== undefined && this.#store.hasActiveToken(token)
      ? token
      : undefined;
  }

  seen(runner: RunnerConnection): void {
    this.#setOnline(runner, true);
  }

  setDefault(request: Request, runnerId: string): Response {
    return setOwnedDefault(request, this.#auth, (userId) => {
      return this.#store.setDefault(userId, runnerId, this.#now());
    });
  }

  async setScopes(request: Request, runnerId: string): Promise<Response> {
    return updateAuthenticatedConnectionScopes(
      request,
      (action) => withAuthenticatedUser(this.#auth, request, action),
      (userId, workspaceIds) =>
        this.#store.setScopes(userId, runnerId, workspaceIds, this.#now()),
    );
  }

  #collectionForUser(request: Request, user: AuthenticatedUser): Response {
    return scopedCollectionForUser({
      create: () => this.#createSetup(request, user),
      key: "runners",
      read: (userId, workspaceId) =>
        this.#store.list(userId, this.#now(), workspaceId),
      request,
      user,
      validate: (userId, workspaceId) =>
        this.#store.workspaceScopesAreValid(userId, [workspaceId]),
    });
  }

  #serveInstaller(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (
      token === null ||
      !RUNNER_TOKEN_PATTERN.test(token) ||
      !this.#store.hasActiveToken(token)
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

  #createSetup(request: Request, user: AuthenticatedUser): Response {
    const workspaceId = requestWorkspaceId(request);
    const workspaceIds = workspaceId === null ? undefined : [workspaceId];
    if (
      workspaceIds !== undefined &&
      (!isWorkspaceId(workspaceId) ||
        !this.#store.workspaceScopesAreValid(user.id, workspaceIds))
    ) {
      return createApiError("invalid_scope", 409);
    }
    const token = createRunnerToken(this.#randomToken);
    const runner = this.#store.create(
      user.id,
      token,
      this.#now(),
      workspaceIds,
    );
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
}

export function createRunnerIntegration(
  auth: GoogleAuth,
  dependencies: RunnerDependencies = {},
): RunnerIntegration {
  return new DrizzleRunnerIntegration(auth, dependencies);
}
