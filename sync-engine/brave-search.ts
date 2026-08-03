import { isRecord } from "../shared/auth-model.ts";
import { createCredentialCipher } from "../shared/credential-cipher.ts";
import { CredentialPoolBalancer } from "../shared/credential-pool-balancer.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { ProviderCredentialStore } from "../shared/provider-credential-store.ts";
import { isWorkspaceId } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  normalizeOptionalValue,
  readJsonRecord,
  type JsonRecord,
  type OAuthDependencies,
} from "./oauth.ts";
import { ProviderCredentialEndpoints } from "./provider-credentials.ts";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const QUERY_MAXIMUM_LENGTH = 500;
const DEFAULT_RESULT_COUNT = 10;
const MAXIMUM_RESULT_COUNT = 20;
const BRAVE_SEARCH_RETRYABLE_STATUSES = new Set([401, 403, 429]);

type BraveSearchFetch = NonNullable<OAuthDependencies["fetch"]>;

interface BraveSearchDependencies {
  readonly database?: AppDatabase;
  readonly fetch?: BraveSearchFetch;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
}

type BraveSearchArguments = JsonRecord;

export interface BraveSearchExecutor {
  execute(
    userId: string,
    workspaceId: string,
    arguments_: BraveSearchArguments,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface BraveSearchSkill extends BraveSearchExecutor {
  keys(request: Request): Promise<Response>;
  remove(request: Request, keyId: string): Response;
  setScopes(request: Request, keyId: string): Promise<Response>;
}

function optionalCount(value: unknown): number | undefined {
  return value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAXIMUM_RESULT_COUNT)
    ? value
    : Number.NaN;
}

function requestParameters(
  arguments_: BraveSearchArguments,
): URLSearchParams | undefined {
  const query = arguments_["query"];
  const count = optionalCount(arguments_["count"]);

  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.trim().length > QUERY_MAXIMUM_LENGTH ||
    Number.isNaN(count)
  ) {
    return undefined;
  }

  return new URLSearchParams({
    q: query.trim(),
    count: String(count ?? DEFAULT_RESULT_COUNT),
  });
}

function optionalResultString(
  result: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = result[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resultSummary(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error("Brave Search returned an invalid result");
  }

  const title = optionalResultString(value, "title");
  const url = optionalResultString(value, "url");

  if (title === undefined || url === undefined) {
    throw new Error("Brave Search returned an invalid result");
  }

  const age = optionalResultString(value, "age");
  const description = optionalResultString(value, "description");
  return {
    ...(age === undefined ? {} : { age }),
    ...(description === undefined ? {} : { description }),
    title,
    url,
  };
}

async function searchResponse(
  fetch: BraveSearchFetch,
  apiKey: string,
  parameters: URLSearchParams,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${BRAVE_SEARCH_API_URL}?${parameters.toString()}`, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

async function readSearchOutput(
  response: Response,
  query: string,
): Promise<string> {
  const value = await readJsonRecord(
    response,
    "Brave Search returned an invalid response",
  );

  const web = value["web"];
  const results = isRecord(web) ? web["results"] : undefined;

  if (results !== undefined && !Array.isArray(results)) {
    throw new Error("Brave Search returned invalid web results");
  }

  return JSON.stringify({
    query,
    results: (results ?? []).map(resultSummary),
  });
}

type BraveSearchExecute = BraveSearchSkill["execute"];

class BraveSearchSkillIntegration implements BraveSearchSkill {
  readonly #balancer: CredentialPoolBalancer;
  readonly #credentials: ProviderCredentialEndpoints;
  readonly #fetch: BraveSearchFetch;
  readonly #store: ProviderCredentialStore | undefined;

  constructor(
    auth: GoogleAuth,
    dependencies: BraveSearchDependencies,
    encodedCredentialKey: string | undefined,
  ) {
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#balancer = new CredentialPoolBalancer({
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    this.#store =
      encodedCredentialKey === undefined
        ? undefined
        : new ProviderCredentialStore(
            dependencies.database ?? createDatabase(":memory:"),
            createCredentialCipher(
              encodedCredentialKey,
              "BRAVE_SEARCH_CREDENTIAL_KEY",
            ),
            "brave_search",
            dependencies.randomId ?? createUuidV7,
          );
    this.#credentials = new ProviderCredentialEndpoints({
      auth,
      labelRequired: true,
      now: dependencies.now ?? Date.now,
      readCredentialDetails: (_apiKey, { label }) =>
        Promise.resolve({
          accountId: null,
          label: label ?? "Brave Search key",
        }),
      store: this.#store,
      validateApiKey: (apiKey) => apiKey.startsWith("BSA"),
    });
  }

  keys(request: Request): Promise<Response> {
    return this.#credentials.credentials(request);
  }

  remove(request: Request, keyId: string): Response {
    return this.#credentials.remove(request, keyId);
  }

  setScopes(request: Request, keyId: string): Promise<Response> {
    return this.#credentials.setScopes(request, keyId);
  }

  execute: BraveSearchExecute = async (
    userId,
    workspaceId,
    arguments_,
    signal,
  ) => {
    if (!isWorkspaceId(workspaceId)) {
      return "Error: the Brave Search workspace is invalid.";
    }
    if (this.#store === undefined) {
      return "Error: Brave Search credential storage is not configured.";
    }

    const parameters = requestParameters(arguments_);

    if (parameters === undefined) {
      return "Error: query must be a non-empty string and count must be an integer from 1 to 20.";
    }

    const credentials = this.#store.list(userId, workspaceId);

    if (credentials.length === 0) {
      return "Error: no Brave Search API keys are available.";
    }

    for (const credential of this.#balancer.ordered(
      `${userId}:${workspaceId}:brave_search`,
      credentials,
    )) {
      try {
        const secret = this.#store.readSecret(
          userId,
          credential.id,
          workspaceId,
        );

        if (secret === undefined) {
          continue;
        }

        const response = await searchResponse(
          this.#fetch,
          secret,
          parameters,
          signal,
        );

        if (response.ok) {
          return await readSearchOutput(response, parameters.get("q") ?? "");
        }

        if (BRAVE_SEARCH_RETRYABLE_STATUSES.has(response.status)) {
          this.#balancer.coolDown(
            `${userId}:${workspaceId}:brave_search`,
            credential.id,
          );
          continue;
        }

        if (response.status >= 500) {
          continue;
        }

        return `Error: Brave Search failed with status ${String(response.status)}.`;
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        // Try the next owned key when the provider or network rejects this one.
      }
    }

    return "Error: Brave Search failed with every saved API key.";
  };
}

export function createBraveSearchSkillFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  auth: GoogleAuth,
  ...optionalDependencies: [dependencies?: BraveSearchDependencies]
): BraveSearchSkill {
  const dependencies = optionalDependencies[0] ?? {};
  const credentialKey = normalizeOptionalValue(
    environment["BRAVE_SEARCH_CREDENTIAL_KEY"],
  );
  const integration = new BraveSearchSkillIntegration(
    auth,
    dependencies,
    credentialKey,
  );
  return integration;
}
