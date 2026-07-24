import { randomBytes } from "node:crypto";
import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import { RUNNER_INSTALLER_PATH } from "../shared/routes.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { isWorkspaceId } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import type { OAuthDependencies } from "./oauth.ts";
import { setOwnedDefault } from "./owned-default.ts";
import { quoteShellValue, renderRunnerInstaller } from "./runner-installer.ts";
import {
  RunnerStore,
  type RunnerConnection,
  type RunnerMetadata,
  type RunnerPage,
} from "./runner-store.ts";

const RUNNER_TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const MACHINE_FINGERPRINT_PATTERN = /^[A-Za-z\d._:-]{8,200}$/u;
const MACHINE_VALUE_PATTERN = /^[A-Za-z\d._ -]{1,100}$/u;

type RunnerDependencies = Pick<
  OAuthDependencies,
  "database" | "now" | "randomId" | "randomToken"
>;

interface ConnectedRunner {
  readonly connection: RunnerConnection;
  readonly userId: string;
}

interface RunnerOptionQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
}

export interface RunnerIntegration {
  collection(request: Request): Response;
  connect(token: string, metadata: RunnerMetadata): ConnectedRunner | undefined;
  disconnected(runner: RunnerConnection): void;
  installer(request: Request): Response;
  listForUser(userId: string, workspaceId: string): readonly RunnerSummary[];
  listOnlineForUser(
    userId: string,
    query: RunnerOptionQuery,
    workspaceId: string,
  ): RunnerPage;
  remove(request: Request, runnerId: string): Response;
  runnerIsAvailable(
    userId: string,
    runnerId: string,
    workspaceId: string,
  ): boolean;
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

function parseConnectionScopes(
  request: Request,
): Promise<readonly string[] | undefined> {
  return parseJsonRequest(request, (value) => {
    if (!isRecord(value) || !Array.isArray(value["workspaceIds"])) {
      return undefined;
    }
    const workspaceIds: readonly unknown[] = value["workspaceIds"];
    return workspaceIds.length > 0 && workspaceIds.every(isWorkspaceId)
      ? workspaceIds.map(String)
      : undefined;
  });
}

function normalizeMachineValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return MACHINE_VALUE_PATTERN.test(normalized) ? normalized : undefined;
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
  readonly #randomToken: () => string;
  readonly #store: RunnerStore;

  constructor(auth: GoogleAuth, dependencies: RunnerDependencies) {
    this.#auth = auth;
    this.#now = dependencies.now ?? Date.now;
    this.#randomToken = dependencies.randomToken ?? defaultRandomToken;
    this.#store = new RunnerStore(
      dependencies.database ?? createDatabase(":memory:"),
      dependencies.randomId ?? createUuidV7,
    );
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
    const result = this.#store.register(token, metadata, this.#now());
    const connection =
      result.status === "registered"
        ? this.#store.authenticate(token)
        : undefined;
    return connection === undefined
      ? undefined
      : { connection, userId: connection.userId };
  }

  #setOnline(runner: RunnerConnection, online: boolean): void {
    this.#store.setOnline(runner.id, runner.userId, this.#now(), online);
  }

  disconnected(runner: RunnerConnection): void {
    this.#setOnline(runner, false);
  }

  listForUser(userId: string, workspaceId: string): readonly RunnerSummary[] {
    return this.#store.list(userId, this.#now(), workspaceId);
  }

  listOnlineForUser(
    userId: string,
    query: RunnerOptionQuery,
    workspaceId: string,
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

  installer(request: Request): Response {
    return request.method === "GET"
      ? this.#serveInstaller(request)
      : createMethodNotAllowedResponse("GET");
  }

  remove(request: Request, runnerId: string): Response {
    return request.method === "DELETE"
      ? withAuthenticatedUser(this.#auth, request, (user) =>
          this.#store.remove(user.id, runnerId, this.#now())
            ? createNoContentResponse()
            : createApiError("not_found", 404),
        )
      : createMethodNotAllowedResponse("DELETE");
  }

  runnerIsAvailable(
    userId: string,
    runnerId: string,
    workspaceId: string,
  ): boolean {
    return this.#store.isAvailable(userId, runnerId, this.#now(), workspaceId);
  }

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
    if (request.method !== "PUT") {
      return createMethodNotAllowedResponse("PUT");
    }
    return await Promise.resolve(
      withAuthenticatedUser(this.#auth, request, async (user) => {
        const workspaceIds = await parseConnectionScopes(request);
        if (workspaceIds === undefined) {
          return createApiError("invalid_request", 400);
        }
        try {
          return this.#store.setScopes(
            user.id,
            runnerId,
            workspaceIds,
            this.#now(),
          )
            ? createNoContentResponse()
            : createApiError("not_found", 404);
        } catch {
          return createApiError("invalid_scope", 409);
        }
      }),
    );
  }

  #collectionForUser(request: Request, user: AuthenticatedUser): Response {
    if (request.method === "GET") {
      const workspaceId = new URL(request.url).searchParams.get("workspaceId");
      if (
        workspaceId !== null &&
        !this.#store.workspaceScopesAreValid(user.id, [workspaceId])
      ) {
        return createApiError("invalid_scope", 409);
      }
      return createJsonResponse({
        runners: this.#store.list(
          user.id,
          this.#now(),
          workspaceId ?? undefined,
        ),
      });
    }

    return request.method === "POST"
      ? this.#createSetup(request, user)
      : createMethodNotAllowedResponse("GET, POST");
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
    const workspaceId = new URL(request.url).searchParams.get("workspaceId");
    const workspaceIds =
      workspaceId === null
        ? undefined
        : isWorkspaceId(workspaceId) &&
            this.#store.workspaceScopesAreValid(user.id, [workspaceId])
          ? [workspaceId]
          : [];
    if (workspaceIds?.length === 0) {
      return createApiError("invalid_scope", 409);
    }
    const token = createRunnerToken(this.#randomToken);
    let runner: RunnerSummary;
    try {
      runner = this.#store.create(user.id, token, this.#now(), workspaceIds);
    } catch {
      return createApiError("invalid_scope", 409);
    }
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
