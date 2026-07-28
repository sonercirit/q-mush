import {
  createCredentialCipher,
  type CredentialCipher,
} from "../shared/credential-cipher.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
  type ProviderCredentialDetails,
  type ProviderId,
} from "../shared/provider-credential-store.ts";
import { ProviderQuotaStore } from "../shared/provider-quota-store.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  ConnectedAccountOAuth,
  type ConnectedAccountOAuthConfiguration,
} from "./connected-account-oauth.ts";
import {
  createOAuthRuntime,
  normalizeOptionalValue,
  validateRedirectUri,
  type OAuthDependencies,
  type OAuthEndpoints,
  type OAuthRuntime,
} from "./oauth.ts";
import type {
  ProviderCredentialRead,
  ProviderCredentialReader,
} from "./provider-credential-reader.ts";
import { ProviderCredentialEndpoints } from "./provider-credentials.ts";
import { ProviderQuotaEndpoints } from "./provider-quota-endpoints.ts";
import type {
  ProviderQuotaReader,
  ProviderQuotaResetter,
} from "./provider-quota.ts";
import { SessionCredentialReassignmentStore } from "./session-credential-reassignment-store.ts";
import {
  SessionCredentialReassignmentEndpoints,
  type SessionCredentialProviderPreparationContext,
  type SessionCredentialProviderPreparationResult,
} from "./session-credential-reassignment.ts";

export interface ProviderIntegration
  extends OAuthEndpoints, ProviderCredentialReader {
  quota(request: Request, credentialId: string): Promise<Response> | Response;
  resetQuota(request: Request, credentialId: string): Promise<Response>;
  setQuotaThreshold(request: Request, credentialId: string): Promise<Response>;
}

export interface ProviderIntegrationConfiguration {
  readonly cipher: CredentialCipher;
  readonly redirectUri?: string;
}

type OAuthConfigurationFactory = (
  runtime: OAuthRuntime,
) => Omit<ConnectedAccountOAuthConfiguration, "redirectUri">;

export function readProviderIntegrationConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly callbackPath: string;
    readonly credentialKeyVariable: string;
    readonly missingKeyMessage: string;
    readonly redirectUriVariable: string;
    readonly settingsConfigured?: boolean;
  },
): ProviderIntegrationConfiguration | undefined {
  const encodedCredentialKey = normalizeOptionalValue(
    environment[options.credentialKeyVariable],
  );
  const redirectUri = normalizeOptionalValue(
    environment[options.redirectUriVariable],
  );

  if (encodedCredentialKey === undefined) {
    if (redirectUri !== undefined || options.settingsConfigured === true) {
      throw new Error(options.missingKeyMessage);
    }

    return undefined;
  }

  return {
    cipher: createCredentialCipher(
      encodedCredentialKey,
      options.credentialKeyVariable,
    ),
    ...(redirectUri === undefined
      ? {}
      : {
          redirectUri: validateRedirectUri(
            redirectUri,
            options.callbackPath,
            options.redirectUriVariable,
          ),
        }),
  };
}

type CredentialDetailsReader = (
  runtime: OAuthRuntime,
  apiKey: string,
) => Promise<ProviderCredentialDetails>;

export function createProviderIntegration(options: {
  readonly auth: GoogleAuth;
  readonly configuration: ProviderIntegrationConfiguration | undefined;
  readonly createOAuthConfiguration: OAuthConfigurationFactory;
  readonly dependencies: OAuthDependencies;
  readonly prepareCredential?: (
    runtime: OAuthRuntime,
    credential: ProviderCredentialAccess,
  ) => Promise<string | undefined>;
  readonly prepareSessionCredentialProviderState?: (
    context: SessionCredentialProviderPreparationContext & {
      readonly credential: ProviderCredentialAccess;
    },
  ) => Promise<SessionCredentialProviderPreparationResult>;
  readonly provider: ProviderId;
  readonly readCredentialDetails: CredentialDetailsReader;
  readonly createQuotaReader: (runtime: OAuthRuntime) => ProviderQuotaReader;
  readonly createQuotaResetter: (
    runtime: OAuthRuntime,
  ) => ProviderQuotaResetter;
}): ProviderIntegration {
  const runtime = createOAuthRuntime(options.dependencies);
  const store =
    options.configuration === undefined
      ? undefined
      : new ProviderCredentialStore(
          runtime.database,
          options.configuration.cipher,
          options.provider,
          runtime.generateId,
        );
  const credentials = new ProviderCredentialEndpoints({
    auth: options.auth,
    now: runtime.now,
    readCredentialDetails: (apiKey) =>
      options.readCredentialDetails(runtime, apiKey),
    store,
  });
  const quotaStore =
    options.configuration === undefined
      ? undefined
      : new ProviderQuotaStore(runtime.database, runtime.generateId);
  const sessionStore =
    options.configuration === undefined
      ? undefined
      : new SessionCredentialReassignmentStore(runtime.database);
  const reassignment = new SessionCredentialReassignmentEndpoints({
    auth: options.auth,
    now: runtime.now,
    ...(options.dependencies.onSessionsChanged === undefined
      ? {}
      : { onChanged: options.dependencies.onSessionsChanged }),
    ...(options.prepareSessionCredentialProviderState === undefined
      ? {}
      : {
          prepareProviderState: async (
            context: SessionCredentialProviderPreparationContext,
          ) => {
            const credential = await readCredential(
              context.userId,
              context.credentialId,
              context.scope?.workspaceId,
            );
            return credential === undefined
              ? { error: "provider_unavailable" as const }
              : (options.prepareSessionCredentialProviderState?.({
                  ...context,
                  credential,
                }) ?? { error: "validation_failed" as const });
          },
        }),
    provider: options.provider,
    ...(options.configuration === undefined
      ? {}
      : {
          scope: (request: Request, userId: string) => {
            const workspaceId = new URL(request.url).searchParams.get(
              "workspaceId",
            );
            if (
              workspaceId === null ||
              !credentials.validateScopes(userId, [workspaceId])
            ) {
              return undefined;
            }
            return { workspaceId };
          },
        }),
    store: sessionStore,
  });
  const baseOAuthConfiguration = options.createOAuthConfiguration(runtime);
  const connectedAccount = new ConnectedAccountOAuth(
    {
      ...baseOAuthConfiguration,
      ...(options.configuration?.redirectUri === undefined
        ? {}
        : { redirectUri: options.configuration.redirectUri }),
    },
    credentials,
    runtime,
  );

  const readCredential: ProviderCredentialRead = async (
    userId,
    credentialId,
    workspaceId,
  ) => {
    const credential = credentials.readCredential(
      userId,
      credentialId,
      workspaceId,
    );

    if (credential === undefined || options.prepareCredential === undefined) {
      return credential;
    }

    const preparedSecret = await options.prepareCredential(runtime, credential);

    if (preparedSecret === undefined) {
      return credential;
    }

    credentials.updateCredentialSecret(
      userId,
      credentialId,
      preparedSecret,
      runtime.now(),
    );
    return { ...credential, secret: preparedSecret };
  };
  const quota = new ProviderQuotaEndpoints(options.auth, {
    now: runtime.now,
    quotaStore,
    readCredential,
    readQuota: options.createQuotaReader(runtime),
    resetQuota: options.createQuotaResetter(runtime),
  });

  return {
    begin: (request) => connectedAccount.begin(request),
    complete: (request) => connectedAccount.complete(request),
    credentials: (request) => credentials.credentials(request),
    quota: (request, credentialId) => quota.read(request, credentialId),
    readCredential,
    reassignSessions: (request, credentialId) =>
      reassignment.reassign(request, credentialId),
    setDefault: (request, credentialId) =>
      credentials.setDefault(request, credentialId),
    setScopes: (request, credentialId) =>
      credentials.setScopes(request, credentialId),
    remove: (request, credentialId) =>
      credentials.remove(request, credentialId),
    resetQuota: (request, credentialId) => quota.consume(request, credentialId),
    setQuotaThreshold: (request, credentialId) =>
      quota.setThreshold(request, credentialId),
  };
}
