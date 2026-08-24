import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import {
  MAXIMUM_RUNNER_PATH_LENGTH,
  readRunnerDirectoryListing,
  RUNNER_DIRECTORY_COMMAND,
  type RunnerDirectoryListing,
} from "../shared/runner-directory-model.ts";
import { readIdentifier, throwIfSignalAborted } from "../shared/validation.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";

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

export interface SessionRequestHelpers {
  readonly authenticate: SessionRequestAuthenticator;
  browseDirectories(
    request: RunnerDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<RunnerDirectoryBrowseResult>;
  directories(
    request: Request,
    runnerId: string,
    workspaceId?: string,
  ): Promise<Response>;
  forUser<Result extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => Result,
  ): Response | Result;
  postForUser(
    request: Request,
    action: (user: AuthenticatedUser) => Promise<Response> | Response,
  ): Promise<Response> | Response;
  recordWorkResult(
    request: Request,
    runnerId: string,
    commandId: string,
  ): Promise<Response>;
}

export function createSessionRequestHelpers(
  auth: GoogleAuth,
  broker: RunnerCommandBroker,
  runners: RunnerAvailability,
): SessionRequestHelpers {
  const authenticate: SessionRequestAuthenticator = (
    request,
    method,
    action,
  ) => {
    if (request.method !== method) {
      return createMethodNotAllowedResponse(method);
    }
    return withAuthenticatedUser(auth, request, action);
  };

  const browseDirectories = async (
    request: RunnerDirectoryRequest,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<RunnerDirectoryBrowseResult> => {
    if (
      !runners.runnerIsAvailable(
        request.userId,
        request.runnerId,
        request.workspaceId,
      ) ||
      request.authorize?.() === false
    ) {
      return { status: "runner_unavailable" };
    }

    try {
      const result = await broker.dispatch(
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
      throwIfSignalAborted(signal, "Directory browsing was canceled");
      const value: unknown = JSON.parse(result.output);
      return { listing: readRunnerDirectoryListing(value), status: "listed" };
    } catch {
      throwIfSignalAborted(signal, "Directory browsing was canceled");
      return { status: "directory_unavailable" };
    }
  };

  const forUser: SessionRequestHelpers["forUser"] = (request, action) =>
    withAuthenticatedUser(auth, request, action);

  const directoriesForUser = async (
    request: Request,
    user: AuthenticatedUser,
    runnerId: string,
    workspaceId?: string,
  ): Promise<Response> => {
    const path = await parseJsonRequest(request, (value) => {
      const parsed = readStringField(
        value,
        "path",
        MAXIMUM_RUNNER_PATH_LENGTH,
        {
          trim: true,
        },
      );
      return parsed?.includes("\0") === false ? parsed : undefined;
    });
    if (
      path === undefined ||
      readIdentifier(runnerId) === undefined ||
      !runners.runnerIsAvailable(user.id, runnerId, workspaceId)
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
      result = await browseDirectories(
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
    const handlers: Record<
      RunnerDirectoryBrowseResult["status"],
      () => Response
    > = {
      directory_unavailable: () => createApiError("directory_unavailable", 502),
      listed: () =>
        result.status === "listed"
          ? createJsonResponse(result.listing)
          : createApiError("directory_unavailable", 502),
      runner_unavailable: () => createApiError("runner_unavailable", 409),
    };
    return handlers[result.status]();
  };

  return {
    authenticate,
    browseDirectories,
    directories: (request, runnerId, workspaceId) =>
      Promise.resolve(
        authenticate(request, "POST", (user) =>
          directoriesForUser(request, user, runnerId, workspaceId),
        ),
      ),
    forUser,
    postForUser: (request, action) =>
      request.method === "POST"
        ? forUser(request, action)
        : createMethodNotAllowedResponse("POST"),
    recordWorkResult: async (request, runnerId, commandId) => {
      const output = await parseJsonRequest(request, (value) => {
        const parsed = isRecord(value) ? value["output"] : undefined;
        return typeof parsed === "string" ? parsed : undefined;
      });
      if (output === undefined) return createApiError("invalid_request", 400);
      return broker.complete(runnerId, commandId, {
        output,
        state: "completed",
      })
        ? createNoContentResponse()
        : createApiError("not_found", 404);
    },
  };
}
