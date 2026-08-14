import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import {
  MAXIMUM_RUNNER_PATH_LENGTH,
  readRunnerDirectoryListing,
  RUNNER_DIRECTORY_COMMAND,
  type RunnerDirectoryListing,
} from "../shared/runner-directory-model.ts";
import { readIdentifier } from "../shared/validation.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import { directoryUnavailable } from "./session-directory-cancellation.ts";

export { readIdentifier };

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

export type SessionRequestAuthenticator = <
  Result extends Promise<Response> | Response,
>(
  request: Request,
  method: string,
  action: (user: AuthenticatedUser) => Result,
) => Response | Result;

export interface RunnerDirectoryRequest {
  readonly authorize?: () => boolean;
  readonly path: string;
  readonly runnerId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId?: string;
}

export type RunnerDirectoryBrowseResult =
  | { readonly listing: RunnerDirectoryListing; readonly status: "listed" }
  | { readonly status: "directory_unavailable" | "runner_unavailable" };

export function readWorkingDirectory(value: unknown): string | undefined {
  const workingDirectory = readStringField(
    value,
    "workingDirectory",
    MAXIMUM_RUNNER_PATH_LENGTH,
    { trim: true },
  );
  return workingDirectory?.includes("\0") === false
    ? workingDirectory
    : undefined;
}

interface RunnerAvailability {
  runnerIsAvailable(
    userId: string,
    runnerId: string,
    workspaceId?: string,
  ): boolean;
}

export class SessionRequestHelpers {
  readonly #auth: GoogleAuth;
  readonly #broker: RunnerCommandBroker;
  readonly #runners: RunnerAvailability;

  constructor(
    auth: GoogleAuth,
    broker: RunnerCommandBroker,
    runners: RunnerAvailability,
  ) {
    this.#auth = auth;
    this.#broker = broker;
    this.#runners = runners;
  }

  authenticate: SessionRequestAuthenticator = (request, method, action) => {
    if (request.method !== method) {
      return createMethodNotAllowedResponse(method);
    }
    return withAuthenticatedUser(this.#auth, request, action);
  };

  async browseDirectories(
    request: RunnerDirectoryRequest,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<RunnerDirectoryBrowseResult> {
    if (
      !this.#runners.runnerIsAvailable(
        request.userId,
        request.runnerId,
        request.workspaceId,
      ) ||
      request.authorize?.() === false
    ) {
      return { status: "runner_unavailable" };
    }

    try {
      const result = await this.#broker.dispatch(
        {
          arguments: {},
          executionEnvironment: "bare_metal",
          ...(request.authorize === undefined
            ? {}
            : { authorize: request.authorize }),
          runnerId: request.runnerId,
          sessionId: request.sessionId,
          tool: RUNNER_DIRECTORY_COMMAND,
          workingDirectory: request.path,
        },
        signal,
      );
      const value: unknown = JSON.parse(result.output);
      return {
        listing: readRunnerDirectoryListing(value),
        status: "listed",
      };
    } catch {
      directoryUnavailable(signal);
      return { status: "directory_unavailable" };
    }
  }

  directories(
    request: Request,
    runnerId: string,
    workspaceId?: string,
  ): Promise<Response> {
    return Promise.resolve(
      this.authenticate(request, "POST", (user) =>
        this.#directoriesForUser(request, user, runnerId, workspaceId),
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
    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("POST");
    }
    return this.forUser(request, action);
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
    workspaceId?: string,
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
      !this.#runners.runnerIsAvailable(user.id, runnerId, workspaceId)
    ) {
      return path === undefined
        ? createApiError("invalid_request", 400)
        : createApiError("runner_unavailable", 409);
    }

    const browseSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(15_000),
    ]);
    let result: RunnerDirectoryBrowseResult;
    try {
      result = await this.browseDirectories(
        {
          path,
          runnerId,
          sessionId: `directory-picker:${user.id}`,
          userId: user.id,
        },
        browseSignal,
      );
    } catch (error) {
      // Browser disconnects and the route deadline cancel the broker command.
      // The HTTP boundary must still settle with its normal browse error.
      if (!browseSignal.aborted) throw error;
      result = { status: "directory_unavailable" };
    }
    switch (result.status) {
      case "directory_unavailable":
        return createApiError("directory_unavailable", 502);
      case "listed":
        return createJsonResponse(result.listing);
      case "runner_unavailable":
        return createApiError("runner_unavailable", 409);
    }
  }
}
