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
  readJsonRequest,
} from "./http.ts";
import { createUuidV7 } from "./ids.ts";
import type { OAuthDependencies } from "./oauth.ts";
import { RUNNER_INSTALLER_PATH } from "./routes.ts";
import { quoteShellValue, renderRunnerInstaller } from "./runner-installer.ts";
import {
  RunnerStore,
  type RunnerMetadata,
  type RunnerRegistrationResult,
} from "./runner-store.ts";

const RUNNER_TOKEN_PATTERN = /^qmr_[A-Za-z\d_-]{8,200}$/u;
const MACHINE_FINGERPRINT_PATTERN = /^[A-Za-z\d._:-]{8,200}$/u;
const MACHINE_VALUE_PATTERN = /^[A-Za-z\d._ -]{1,100}$/u;

type RunnerDependencies = Pick<
  OAuthDependencies,
  "database" | "now" | "randomId" | "randomToken"
>;

export interface RunnerIntegration {
  collection(request: Request): Response;
  heartbeat(request: Request): Response;
  installer(request: Request): Response;
  register(request: Request): Promise<Response>;
  remove(request: Request, runnerId: string): Response;
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

function readRunnerMetadata(value: unknown): RunnerMetadata | undefined {
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

function registrationResponse(result: RunnerRegistrationResult): Response {
  switch (result.status) {
    case "registered":
      return createJsonResponse({ id: result.id }, 201);
    case "runner_exists":
      return createApiError("runner_exists", 409);
    case "token_already_used":
      return createApiError("token_already_used", 409);
    case "unknown_token":
      return createApiError("invalid_token", 401);
  }
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

  heartbeat(request: Request): Response {
    return request.method === "POST"
      ? this.#recordHeartbeat(request)
      : createMethodNotAllowedResponse("POST");
  }

  installer(request: Request): Response {
    return request.method === "GET"
      ? this.#serveInstaller(request)
      : createMethodNotAllowedResponse("GET");
  }

  async register(request: Request): Promise<Response> {
    return request.method === "POST"
      ? this.#registerComputer(request)
      : createMethodNotAllowedResponse("POST");
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

  #recordHeartbeat(request: Request): Response {
    const token = readBearerToken(request);
    const connected =
      token !== undefined && this.#store.heartbeat(token, this.#now());
    return connected
      ? createNoContentResponse()
      : createApiError("invalid_token", 401);
  }

  async #registerComputer(request: Request): Promise<Response> {
    const token = readBearerToken(request);

    if (token === undefined) {
      return createApiError("invalid_token", 401);
    }

    const json = await readJsonRequest(request);
    const metadata = json.ok ? readRunnerMetadata(json.value) : undefined;
    return metadata === undefined
      ? createApiError("invalid_request", 400)
      : registrationResponse(
          this.#store.register(token, metadata, this.#now()),
        );
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
