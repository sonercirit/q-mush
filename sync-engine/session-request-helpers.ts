import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import {
  MAXIMUM_RUNNER_PATH_LENGTH,
  readRunnerDirectoryListing,
  RUNNER_DIRECTORY_COMMAND,
} from "../shared/runner-directory-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RunnerIntegration } from "./runners.ts";

export function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z\d._:-]{1,200}$/u.test(value)
    ? value
    : undefined;
}

export function readStringField(
  value: unknown,
  key: string,
  maximumLength: number,
  options: { readonly trim?: boolean } = {},
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];

  if (typeof field !== "string" || field.length > maximumLength) {
    return undefined;
  }

  const normalized = options.trim === true ? field.trim() : field;
  return normalized.length > 0 ? normalized : undefined;
}

export class SessionRequestHelpers {
  readonly #auth: GoogleAuth;
  readonly #broker: RunnerCommandBroker;
  readonly #runners: RunnerIntegration;

  constructor(
    auth: GoogleAuth,
    broker: RunnerCommandBroker,
    runners: RunnerIntegration,
  ) {
    this.#auth = auth;
    this.#broker = broker;
    this.#runners = runners;
  }

  authenticate<Result extends Promise<Response> | Response>(
    request: Request,
    method: string,
    action: (user: AuthenticatedUser) => Result,
  ): Response | Result {
    if (request.method !== method) {
      return createMethodNotAllowedResponse(method);
    }
    return withAuthenticatedUser(this.#auth, request, action);
  }

  directories(request: Request, runnerId: string): Promise<Response> {
    return Promise.resolve(
      this.authenticate(request, "POST", (user) =>
        this.#directoriesForUser(request, user, runnerId),
      ),
    );
  }

  forUser<Result extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => Result,
  ): Response | Result {
    return withAuthenticatedUser(this.#auth, request, action);
  }

  postForUser(
    request: Request,
    action: (user: AuthenticatedUser) => Promise<Response> | Response,
  ): Promise<Response> | Response {
    return this.authenticate(request, "POST", action);
  }

  async recordWorkResult(
    request: Request,
    runnerId: string,
    commandId: string,
  ): Promise<Response> {
    const output = await parseJsonRequest(request, (value) => {
      const parsed = isRecord(value) ? value["output"] : undefined;
      return typeof parsed === "string" ? parsed : undefined;
    });

    if (output === undefined) {
      return createApiError("invalid_request", 400);
    }

    return this.#broker.complete(runnerId, commandId, {
      output,
      state: "completed",
    })
      ? createNoContentResponse()
      : createApiError("not_found", 404);
  }

  async #directoriesForUser(
    request: Request,
    user: AuthenticatedUser,
    runnerId: string,
  ): Promise<Response> {
    const path = await parseJsonRequest(request, (value) => {
      const parsed = readStringField(
        value,
        "path",
        MAXIMUM_RUNNER_PATH_LENGTH,
        { trim: true },
      );
      return parsed?.includes("\0") === false ? parsed : undefined;
    });

    if (
      path === undefined ||
      readIdentifier(runnerId) === undefined ||
      !this.#runners.runnerIsAvailable(user.id, runnerId)
    ) {
      return path === undefined
        ? createApiError("invalid_request", 400)
        : createApiError("runner_unavailable", 409);
    }

    try {
      const result = await this.#broker.dispatch(
        {
          arguments: {},
          runnerId,
          sessionId: `directory-picker:${user.id}`,
          tool: RUNNER_DIRECTORY_COMMAND,
          workingDirectory: path,
        },
        AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      );
      const value: unknown = JSON.parse(result.output);
      return createJsonResponse(readRunnerDirectoryListing(value));
    } catch {
      return createApiError("directory_unavailable", 502);
    }
  }
}
