import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { providerCredentials } from "../../shared/database/schema.ts";
import type { ProviderId } from "../../shared/provider-credential-store.ts";
import type { OAuthDependencies } from "../../sync-engine/oauth.ts";
import type { createOpenAiIntegrationFromEnvironment } from "../../sync-engine/openai.ts";
import type { createOpenRouterIntegrationFromEnvironment } from "../../sync-engine/openrouter.ts";
import type { ProviderIntegration } from "../../sync-engine/provider-integration.ts";
import {
  addFlowCookies,
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

type ProviderFetch = NonNullable<OAuthDependencies["fetch"]>;
type IntegrationFactory =
  | typeof createOpenAiIntegrationFromEnvironment
  | typeof createOpenRouterIntegrationFromEnvironment;

interface ProviderTestConfiguration<Details> {
  readonly createFetch: (
    details: Readonly<Record<string, Details>>,
    requests: Request[],
  ) => ProviderFetch;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly factory: IntegrationFactory;
  readonly ids: readonly string[];
  readonly provider: ProviderId;
  readonly tokens: readonly string[];
}

export function defineProviderTestConfiguration<Details>(
  createFetch: ProviderTestConfiguration<Details>["createFetch"],
  environment: Readonly<Record<string, string | undefined>>,
  factory: IntegrationFactory,
  ids: readonly string[],
  provider: ProviderId,
  tokens: readonly string[],
): ProviderTestConfiguration<Details> {
  return { createFetch, environment, factory, ids, provider, tokens };
}

export interface ProviderTestRoutes {
  readonly callbackPath: string;
  readonly credentialsPath: string;
  readonly oauthPath: string;
  readonly provider: ProviderId;
  readonly resultParameter: string;
}

export function defineProviderTestRoutes(
  provider: ProviderId,
): ProviderTestRoutes {
  const basePath = `/api/${provider}`;
  const oauthPath = `${basePath}/oauth`;
  return {
    callbackPath: `${oauthPath}/callback`,
    credentialsPath: `${basePath}/credentials`,
    oauthPath,
    provider,
    resultParameter: provider,
  };
}

export interface ProviderTestSetup {
  readonly database: AppDatabase;
  readonly integration: ProviderIntegration;
  readonly providerRequests: Request[];
}

function setupProviderIntegration<Details>(
  configuration: ProviderTestConfiguration<Details>,
  details: Readonly<Record<string, Details>> = {},
): ProviderTestSetup {
  const { auth, database } = createAuthenticatedTestContext();
  const providerRequests: Request[] = [];
  const ids = [...configuration.ids];
  const tokens = [...configuration.tokens];
  const integration = configuration.factory(configuration.environment, auth, {
    database,
    fetch: configuration.createFetch(details, providerRequests),
    now: () => TEST_NOW,
    randomId: () => takeValue(ids, "The test ran out of credential IDs"),
    randomToken: () => takeValue(tokens, "The test ran out of OAuth tokens"),
  });

  return { database, integration, providerRequests };
}

export function createProviderTestSetup<Details>(
  configuration: ProviderTestConfiguration<Details>,
): (details?: Readonly<Record<string, Details>>) => ProviderTestSetup {
  return (details = {}) => setupProviderIntegration(configuration, details);
}

export function readStoredProviderCredentials(
  database: AppDatabase,
  provider: ProviderId,
) {
  return database
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.provider, provider))
    .all();
}

export function withOpenAiProviderRequest<Value>(options: {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
  readonly onRequest: (request: Request, token: boolean) => Value;
  readonly requests: Request[];
}): Value {
  const { request, token } = recordOpenAiProviderRequest(
    options.requests,
    options.input,
    options.init,
  );
  return options.onRequest(request, token);
}

export function recordOpenAiProviderRequest(
  requests: Request[],
  input: RequestInfo | URL,
  init?: RequestInit,
): { readonly request: Request; readonly token: boolean } {
  const request = recordProviderRequest(requests, input, init, true);
  return { request, token: isOpenAiTokenRequest(request) };
}

function isOpenAiTokenRequest(request: Request): boolean {
  return request.url === "https://auth.openai.com/oauth/token";
}

export function providerKeyDetailsResponse(
  details: { readonly accountId: string; readonly label: string } | undefined,
): Response {
  return details === undefined
    ? Response.json({ error: "invalid key" }, { status: 401 })
    : Response.json({
        data: {
          creator_user_id: details.accountId,
          label: details.label,
        },
      });
}

export function recordProviderRequest(
  requests: Request[],
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  clone = false,
): Request {
  const request = new Request(input, init);
  requests.push(clone ? request.clone() : request);
  return request;
}

export function readBearerApiKey(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer /u, "");
}

interface AccountConnectionOptions {
  readonly callbackPath: string;
  readonly code: string;
  readonly integration: ProviderIntegration;
  readonly oauthPath: string;
  readonly state: string;
}

export function beginProviderAccount(options: AccountConnectionOptions): {
  readonly authorizationUrl: URL;
  readonly beginResponse: Response;
  readonly callbackRequest: Request;
} {
  const beginResponse = options.integration.begin(
    createAuthenticatedRequest(options.oauthPath),
  );
  const authorizationUrl = new URL(
    beginResponse.headers.get("location") ?? "http://invalid",
  );
  const callbackRequest = createAuthenticatedRequest(
    `${options.callbackPath}?code=${options.code}&state=${options.state}`,
  );
  addFlowCookies(callbackRequest, beginResponse);

  return { authorizationUrl, beginResponse, callbackRequest };
}

export async function connectProviderAccount(
  options: AccountConnectionOptions,
): Promise<{
  readonly authorizationUrl: URL;
  readonly beginResponse: Response;
  readonly response: Response;
}> {
  const connection = beginProviderAccount(options);
  return {
    authorizationUrl: connection.authorizationUrl,
    beginResponse: connection.beginResponse,
    response: await options.integration.complete(connection.callbackRequest),
  };
}

export function createProviderAccountConnector(
  routes: ProviderTestRoutes,
): (
  integration: ProviderIntegration,
  state: string,
  code: string,
) => ReturnType<typeof connectProviderAccount> {
  return (integration, state, code) =>
    connectProviderAccount({
      callbackPath: routes.callbackPath,
      code,
      integration,
      oauthPath: routes.oauthPath,
      state,
    });
}

export function setProviderDefaults(
  integration: ProviderIntegration,
  credentialsPath: string,
  credentialIds: readonly string[],
): readonly number[] {
  return credentialIds.map(
    (credentialId) =>
      integration.setDefault(
        createAuthenticatedRequest(
          `${credentialsPath}/${credentialId}/default`,
          undefined,
          "POST",
        ),
        credentialId,
      ).status,
  );
}

export async function addProviderApiKeys(
  integration: ProviderIntegration,
  credentialsPath: string,
  apiKeys: readonly string[],
): Promise<void> {
  for (const apiKey of apiKeys) {
    const response = await integration.credentials(
      createAuthenticatedRequest(credentialsPath, { apiKey }, "POST"),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain(apiKey);
  }
}

export async function expectInvalidProviderState(
  setup: ProviderTestSetup,
  routes: ProviderTestRoutes,
  code: string,
): Promise<void> {
  const beginResponse = setup.integration.begin(
    createAuthenticatedRequest(routes.oauthPath),
  );
  const callbackRequest = createAuthenticatedRequest(
    `${routes.callbackPath}?code=${code}&state=wrong`,
  );
  addFlowCookies(callbackRequest, beginResponse);
  const response = await setup.integration.complete(callbackRequest);

  expect(response.headers.get("location")).toBe(
    `http://localhost:3000/app?${routes.resultParameter}=invalid_state`,
  );
  expect(setup.providerRequests).toEqual([]);
  expect(
    readStoredProviderCredentials(setup.database, routes.provider),
  ).toEqual([]);
  setup.database.$client.close();
}

export async function expectProtectedInvalidApiKey(
  setup: ProviderTestSetup,
  routes: ProviderTestRoutes,
): Promise<void> {
  const origin = "http://localhost:3000";
  expect(
    (
      await setup.integration.credentials(
        new Request(`${origin}${routes.credentialsPath}`),
      )
    ).status,
  ).toBe(401);
  expect(
    setup.integration.begin(new Request(`${origin}${routes.oauthPath}`)).status,
  ).toBe(401);

  const invalidKeyResponse = await setup.integration.credentials(
    createAuthenticatedRequest(
      routes.credentialsPath,
      { apiKey: "invalid-key" },
      "POST",
    ),
  );
  expect(invalidKeyResponse.status).toBe(400);
  expect(await invalidKeyResponse.json()).toEqual({ error: "invalid_api_key" });
  expect(
    readStoredProviderCredentials(setup.database, routes.provider),
  ).toHaveLength(0);
  setup.database.$client.close();
}

export function expectRemovedProviderCredential(
  setup: ProviderTestSetup,
  routes: ProviderTestRoutes,
  credentialId: string,
): void {
  const response = setup.integration.remove(
    createAuthenticatedRequest(
      `${routes.credentialsPath}/${credentialId}`,
      undefined,
      "DELETE",
    ),
    credentialId,
  );
  expect(response.status).toBe(204);
  const removed = readStoredProviderCredentials(
    setup.database,
    routes.provider,
  ).find(({ id }) => id === credentialId);
  expect(removed?.isDeleted).toBe(true);
  expect(removed?.encryptedCredential).toBe("");
}

export function credentialSummaries<T>(credentials: readonly T[]): {
  readonly credentials: readonly (T & {
    readonly isGlobal: boolean;
    readonly workspaceIds: readonly string[];
  })[];
} {
  return {
    credentials: credentials.map((credential) => ({
      ...credential,
      isGlobal: true,
      requiresReauthentication: false,
      workspaceIds: [],
    })),
  };
}

export function expectProviderCredentialSummaries(
  actual: unknown,
  credentials: readonly unknown[],
): void {
  expect(actual).toEqual(credentialSummaries(credentials));
}

export async function readProviderCredentialSummaries(
  integration: ProviderIntegration,
  credentialsPath: string,
): Promise<unknown> {
  const response = await integration.credentials(
    createAuthenticatedRequest(credentialsPath),
  );
  return response.json();
}
