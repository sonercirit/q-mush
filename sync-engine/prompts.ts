import { isRecord } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import {
  normalizePromptInput,
  PROMPT_BODY_MAXIMUM_BYTES,
  PROMPT_NAME_MAXIMUM_LENGTH,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  createAuthenticatedCollectionIntegration,
  type AuthenticatedCollectionIntegration,
} from "./authenticated-collection-integration.ts";
import type { CollectionItemIntegration } from "./collection-item-integration.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
} from "./http.ts";
import {
  createPromptStore,
  isPromptStoreErrorKind,
  type PromptStore,
} from "./prompt-store.ts";

interface PromptDependencies {
  readonly database?: AppDatabase;
  readonly maximumCount?: number;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
}

export type PromptIntegration = CollectionItemIntegration;

const PROMPT_REQUEST_MAXIMUM_BYTES =
  PROMPT_BODY_MAXIMUM_BYTES + PROMPT_NAME_MAXIMUM_LENGTH * 6 + 1_024;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return (
    contentType !== null &&
    contentType.toLowerCase().split(";", 1)[0]?.trim() === "application/json"
  );
}

function readPromptRevision(request: Request): number | undefined {
  const match = /^"([1-9]\d*)"$/u.exec(request.headers.get("if-match") ?? "");
  if (match === null) {
    return undefined;
  }
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function preconditionResponse(request: Request): number | Response {
  const revision = readPromptRevision(request);
  return revision ?? createApiError("precondition_required", 428);
}

function requestMayFit(request: Request): boolean {
  const declaredLength = request.headers.get("content-length");
  return (
    declaredLength === null ||
    declaredLength === "0" ||
    (POSITIVE_INTEGER_PATTERN.test(declaredLength) &&
      Number(declaredLength) <= PROMPT_REQUEST_MAXIMUM_BYTES)
  );
}

interface ParsedPromptRequest {
  readonly tooLarge: boolean;
  readonly value?: unknown;
}

async function readPromptRequest(
  request: Request,
): Promise<ParsedPromptRequest> {
  if (!hasJsonContentType(request)) {
    return { tooLarge: false };
  }
  if (!requestMayFit(request)) {
    return { tooLarge: true };
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return { tooLarge: false };
  }
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    bytesRead += chunk.value.byteLength;
    if (bytesRead > PROMPT_REQUEST_MAXIMUM_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    body += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  body += decoder.decode();
  try {
    return { tooLarge: false, value: JSON.parse(body) };
  } catch {
    return { tooLarge: false };
  }
}

function readPromptInput(value: unknown): PromptInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const body = value["body"];
  const name = value["name"];
  if (
    typeof body !== "string" ||
    typeof name !== "string" ||
    name.length > PROMPT_NAME_MAXIMUM_LENGTH
  ) {
    return undefined;
  }
  return normalizePromptInput({ body, name });
}

class DrizzlePromptIntegration implements PromptIntegration {
  readonly #authenticated: AuthenticatedCollectionIntegration;
  readonly #now: () => number;
  readonly #store: PromptStore;

  constructor(auth: GoogleAuth, dependencies: PromptDependencies) {
    this.#authenticated = createAuthenticatedCollectionIntegration(auth);
    const database = dependencies.database ?? createDatabase(":memory:");
    this.#now = dependencies.now ?? Date.now;
    this.#store = createPromptStore(
      database,
      dependencies.randomId ?? createUuidV7,
      dependencies.maximumCount,
    );
  }

  collection(request: Request): Promise<Response> | Response {
    const methods = {
      GET: (userId: string) =>
        createJsonResponse({ prompts: this.#store.list(userId) }),
      POST: (userId: string) => this.#write(request, userId),
    };
    return this.#authenticated.collectionRoute(request, methods);
  }

  item(request: Request, promptId: string): Promise<Response> | Response {
    return this.route(request, (userId, method) => {
      const handlers: Record<
        "DELETE" | "GET" | "PUT",
        () => Promise<Response> | Response
      > = {
        DELETE: () => {
          const revision = preconditionResponse(request);
          if (revision instanceof Response) return revision;
          try {
            return this.#store.remove(userId, promptId, this.#now(), revision)
              ? createNoContentResponse()
              : createApiError("not_found", 404);
          } catch (error) {
            return isPromptStoreErrorKind(error, "prompt_changed")
              ? createApiError("prompt_changed", 412)
              : createApiError("storage_unavailable", 500);
          }
        },
        GET: () => this.#promptResponse(this.#store.get(userId, promptId)),
        PUT: () => {
          const revision = preconditionResponse(request);
          return revision instanceof Response
            ? revision
            : this.#write(request, userId, promptId, revision);
        },
      };
      if (method === "DELETE") return handlers.DELETE();
      if (method === "GET") return handlers.GET();
      if (method === "PUT") return handlers.PUT();
      return createMethodNotAllowedResponse("GET, PUT, DELETE");
    });
  }

  async #write(
    request: Request,
    userId: string,
    promptId?: string,
    revision = 1,
  ): Promise<Response> {
    const parsed = await readPromptRequest(request);
    if (parsed.tooLarge) {
      return createApiError("request_too_large", 413);
    }
    const input = readPromptInput(parsed.value);
    if (input === undefined) {
      return createApiError("invalid_request", 400);
    }
    try {
      if (promptId === undefined) {
        return createJsonResponse(
          this.#store.create(userId, input, this.#now()),
          201,
        );
      }
      return this.#promptResponse(
        this.#store.update(userId, promptId, input, this.#now(), revision),
      );
    } catch (error) {
      if (isPromptStoreErrorKind(error, "duplicate_prompt_name")) {
        return createApiError("duplicate_name", 409);
      }
      if (isPromptStoreErrorKind(error, "prompt_changed")) {
        return createApiError("prompt_changed", 412);
      }
      if (isPromptStoreErrorKind(error, "prompt_limit")) {
        return createApiError("prompt_limit_reached", 409);
      }
      return createApiError("storage_unavailable", 500);
    }
  }

  #promptResponse(prompt: Prompt | undefined): Response {
    return prompt === undefined
      ? createApiError("not_found", 404)
      : createJsonResponse(prompt);
  }
}

export function createPromptIntegration(
  auth: GoogleAuth,
  dependencies: PromptDependencies = {},
): PromptIntegration {
  return new DrizzlePromptIntegration(auth, dependencies);
}
