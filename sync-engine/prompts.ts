import { isRecord } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import {
  PROMPT_BODY_MAXIMUM_LENGTH,
  PROMPT_NAME_MAXIMUM_LENGTH,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import { DuplicatePromptNameError, PromptStore } from "./prompt-store.ts";

interface PromptDependencies {
  readonly database?: AppDatabase;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
}

export interface PromptIntegration {
  collection(request: Request): Promise<Response> | Response;
  item(request: Request, promptId: string): Promise<Response> | Response;
}

function readPromptInput(value: unknown): PromptInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawBody = value["body"];
  const rawName = value["name"];
  if (
    typeof rawBody !== "string" ||
    typeof rawName !== "string" ||
    rawBody.length > PROMPT_BODY_MAXIMUM_LENGTH ||
    rawName.length > PROMPT_NAME_MAXIMUM_LENGTH
  ) {
    return undefined;
  }

  const body = rawBody.trim();
  const name = rawName.trim();
  return body.length === 0 || name.length === 0 ? undefined : { body, name };
}

class DrizzlePromptIntegration implements PromptIntegration {
  readonly #auth: GoogleAuth;
  readonly #now: () => number;
  readonly #store: PromptStore;

  constructor(auth: GoogleAuth, dependencies: PromptDependencies) {
    this.#auth = auth;
    const database = dependencies.database ?? createDatabase(":memory:");
    this.#now = dependencies.now ?? Date.now;
    this.#store = new PromptStore(
      database,
      dependencies.randomId ?? createUuidV7,
    );
  }

  #authenticate(
    request: Request,
    serve: (userId: string) => Promise<Response> | Response,
  ): Promise<Response> | Response {
    return withAuthenticatedUser(this.#auth, request, (user) => serve(user.id));
  }

  collection(request: Request): Promise<Response> | Response {
    const collectionForUser = (userId: string) => {
      switch (request.method) {
        case "GET": {
          const result = this.#store.list(userId);
          return createJsonResponse({ prompts: result });
        }
        case "POST":
          return this.#write(request, userId);
        default:
          return createMethodNotAllowedResponse("GET, POST");
      }
    };
    return this.#authenticate(request, collectionForUser);
  }

  item(request: Request, promptId: string): Promise<Response> | Response {
    const serve = (userId: string): Promise<Response> | Response => {
      if (request.method === "GET") {
        return this.#promptResponse(this.#store.get(userId, promptId));
      }
      if (request.method === "PUT") {
        return this.#write(request, userId, promptId);
      }
      if (request.method === "DELETE") {
        const removed = this.#store.remove(userId, promptId, this.#now());
        return removed
          ? createNoContentResponse()
          : createApiError("not_found", 404);
      }
      return createMethodNotAllowedResponse("GET, PUT, DELETE");
    };
    return this.#authenticate(request, serve);
  }

  async #write(
    request: Request,
    userId: string,
    promptId?: string,
  ): Promise<Response> {
    const input = await parseJsonRequest(request, readPromptInput);
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
        this.#store.update(userId, promptId, input, this.#now()),
      );
    } catch (error) {
      if (error instanceof DuplicatePromptNameError) {
        return createApiError("duplicate_name", 409);
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
