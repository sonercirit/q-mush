import { randomBytes } from "node:crypto";
import * as authModel from "./auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import { createDatabase } from "./database.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
} from "./http.ts";
import { createUuidV7 } from "./ids.ts";
import type { OAuthDependencies } from "./oauth.ts";
import { RUNNER_INSTALLER_PATH } from "./routes.ts";
import { quoteShellValue, renderRunnerInstaller } from "./runner-installer.ts";
import type { RunnerSummary } from "./runner-model.ts";
import {
  RunnerStore,
  type RunnerConnection,
  type RunnerMetadata,
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

export interface RunnerIntegration {
  collection(request: Request): Response;
  connect(token: string, metadata: RunnerMetadata): ConnectedRunner | undefined;
  disconnected(runner: RunnerConnection): void;
  installer(request: Request): Response;
  listForUser(userId: string): readonly RunnerSummary[];
  remove(request: Request, runnerId: string): Response;
  runnerIsAvailable(userId: string, runnerId: string): boolean;
  runnerToken(request: Request): string | undefined;
  seen(runner: RunnerConnection): void;
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
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return MACHINE_VALUE_PATTERN.test(normalized) ? normalized : undefined;
}

export function readRunnerMetadata(value: unknown): RunnerMetadata | undefined {
  if (!authModel.isRecord(value)) {
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

  listForUser(userId: string): readonly RunnerSummary[] {
    return this.#store.list(userId, this.#now());
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

  runnerIsAvailable(userId: string, runnerId: string): boolean {
    return this.#store.isAvailable(userId, runnerId, this.#now());
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

  #collectionForUser(
    request: Request,
    user: authModel.AuthenticatedUser,
  ): Response {
    if (request.method === "GET") {
      return createJsonResponse({
        runners: this.#store.list(user.id, this.#now()),
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

  #createSetup(request: Request, user: authModel.AuthenticatedUser): Response {
    const token = createRunnerToken(this.#randomToken);
    const runner = this.#store.create(user.id, token, this.#now());
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
