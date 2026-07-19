import { createHash, randomBytes } from "node:crypto";
import { isRecord } from "./auth-model.ts";
import { createDatabase, type AppDatabase } from "./database.ts";
import {
  createCookie,
  createRedirect,
  readCookie,
  valuesMatch,
} from "./http.ts";
import { createUuidV7, type IdGenerator } from "./ids.ts";

const FLOW_LIFETIME_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z\d_-]+$/u;

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OAuthEndpoints {
  begin(request: Request): Response;
  complete(request: Request): Promise<Response>;
}

export interface OAuthDependencies {
  readonly database?: AppDatabase;
  readonly fetch?: ProviderFetch;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
  readonly randomToken?: () => string;
}

export interface OAuthRuntime {
  readonly database: AppDatabase;
  readonly fetch: ProviderFetch;
  readonly generateId: IdGenerator;
  readonly now: () => number;
  readonly randomToken: () => string;
}

export interface FlowCookies {
  readonly path: string;
  readonly state: string;
  readonly verifier: string;
}

export interface StartedPkceFlow {
  readonly challenge: string;
  readonly cookies: readonly string[];
  readonly state: string;
  readonly verifier: string;
}

export type OAuthCallbackResult =
  | { readonly status: "denied" | "failed" | "invalid_state" }
  | {
      readonly code: string;
      readonly status: "ready";
      readonly verifier: string;
    };

function defaultRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateOAuthToken(randomToken: () => string): string {
  const token = randomToken();

  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("The random token generator returned an invalid token");
  }

  return token;
}

export function createFlowCookie(
  name: string,
  value: string,
  path: string,
  secure: boolean,
): string {
  return createCookie(name, value, FLOW_LIFETIME_SECONDS, path, secure);
}

export function clearPkceCookies(
  names: FlowCookies,
  secure: boolean,
): readonly string[] {
  return [
    createCookie(names.state, "", 0, names.path, secure),
    createCookie(names.verifier, "", 0, names.path, secure),
  ];
}

export function createOAuthRuntime(
  dependencies: OAuthDependencies,
): OAuthRuntime {
  return {
    database: dependencies.database ?? createDatabase(":memory:"),
    fetch: dependencies.fetch ?? globalThis.fetch,
    generateId: dependencies.randomId ?? createUuidV7,
    now: dependencies.now ?? Date.now,
    randomToken: dependencies.randomToken ?? defaultRandomToken,
  };
}

export function normalizeOptionalValue(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

export async function readJsonRecord(
  response: Response,
  errorMessage: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!response.ok) {
    throw new Error(errorMessage);
  }

  const value: unknown = await response.json();

  if (!isRecord(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

export function readOAuthCallback(
  request: Request,
  names: FlowCookies,
): OAuthCallbackResult {
  const callbackUrl = new URL(request.url);
  const expectedState = readCookie(request, names.state);
  const returnedState = callbackUrl.searchParams.get("state");
  const verifier = readCookie(request, names.verifier);

  if (
    expectedState === undefined ||
    returnedState === null ||
    verifier === undefined ||
    !valuesMatch(expectedState, returnedState)
  ) {
    return { status: "invalid_state" };
  }

  const providerError = callbackUrl.searchParams.get("error");

  if (providerError !== null) {
    return {
      status: providerError === "access_denied" ? "denied" : "failed",
    };
  }

  const code = callbackUrl.searchParams.get("code");
  return code === null || code.length === 0
    ? { status: "failed" }
    : { code, status: "ready", verifier };
}

function validateProviderString(
  value: unknown,
  key: string,
  provider: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${provider} returned an invalid ${key}`);
  }

  return value;
}

export const readProviderString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  provider: string,
): string => validateProviderString(record[key], key, provider);

export function readProviderUserId(field: {
  readonly key: string;
  readonly provider: string;
  readonly record: Readonly<Record<string, unknown>>;
}): string | null {
  const { key, provider, record } = field;
  const value = record[key];
  return value === null || value === undefined
    ? null
    : validateProviderString(value, key, provider);
}

export function redirectToApp(
  appPath: string,
  redirectUri: string,
  parameter: string,
  result: string | undefined,
  cookies: readonly string[],
): Response {
  const appUrl = new URL(appPath, redirectUri);

  if (result !== undefined) {
    appUrl.searchParams.set(parameter, result);
  }

  return createRedirect(appUrl, cookies);
}

export function resolveRedirectUri(
  configuredUri: string | undefined,
  callbackPath: string,
  request: Request,
): string {
  return configuredUri ?? new URL(callbackPath, request.url).toString();
}

export function startPkceFlow(
  runtime: OAuthRuntime,
  names: FlowCookies,
  secure: boolean,
): StartedPkceFlow {
  const state = generateOAuthToken(runtime.randomToken);
  const verifier = generateOAuthToken(runtime.randomToken);

  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    cookies: [
      createFlowCookie(names.state, state, names.path, secure),
      createFlowCookie(names.verifier, verifier, names.path, secure),
    ],
    state,
    verifier,
  };
}

export function validateRedirectUri(
  value: string,
  callbackPath: string,
  variableName: string,
): string {
  const redirectUrl = new URL(value);

  if (
    (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") ||
    redirectUrl.pathname !== callbackPath ||
    redirectUrl.search.length > 0 ||
    redirectUrl.hash.length > 0
  ) {
    throw new Error(
      `${variableName} must be an HTTP(S) URL ending in ${callbackPath}`,
    );
  }

  return redirectUrl.toString();
}
