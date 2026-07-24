import {
  createCredentialCipher,
  type CredentialCipher,
} from "../shared/credential-cipher.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
  type ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderLimitObservation } from "../shared/provider-limits.ts";
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
import {
  ProviderCredentialEndpoints,
  type ReadCredentialDetails,
} from "./provider-credentials.ts";
import { ProviderLimitStore } from "./provider-limit-store.ts";
import { ProviderLimitsService } from "./provider-limits-service.ts";

export interface ProviderIntegration extends OAuthEndpoints {
  credentials(request: Request): Promise<Response>;
  readCredential(
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess | undefined>;
  setDefault(request: Request, credentialId: string): Response;
  remove(request: Request, credentialId: string): Response;
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
) => ReturnType<ReadCredentialDetails>;

export function createProviderIntegration(options: {
  readonly auth: GoogleAuth;
  readonly configuration: ProviderIntegrationConfiguration | undefined;
  readonly createOAuthConfiguration: OAuthConfigurationFactory;
  readonly dependencies: OAuthDependencies;
  readonly prepareCredential?: (
    runtime: OAuthRuntime,
    credential: ProviderCredentialAccess,
  ) => Promise<string | undefined>;
  readonly provider: ProviderId;
  readonly readCredentialDetails: CredentialDetailsReader;
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
  const limits =
    options.dependencies.limits ??
    new ProviderLimitsService(
      new ProviderLimitStore(runtime.database, runtime.generateId),
      runtime.now,
    );
  const observeLimits = (
    userId: string,
    credentialId: string,
    observation: ProviderLimitObservation,
  ): void => {
    limits.observe(userId, credentialId, observation);
  };
  const credentials = new ProviderCredentialEndpoints({
    auth: options.auth,
    now: runtime.now,
    observeLimits,
    readCredentialDetails: (apiKey) =>
      options.readCredentialDetails(runtime, apiKey),
    readLimits: (userId, credentialId) => limits.read(userId, credentialId),
    store,
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

  const readCredential = async (
    userId: string,
    credentialId: string,
  ): Promise<ProviderCredentialAccess | undefined> => {
    const credential = credentials.readCredential(userId, credentialId);

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
    return {
      accountId: credential.accountId,
      id: credential.id,
      isDefault: credential.isDefault,
      label: credential.label,
      source: credential.source,
      secret: preparedSecret,
    };
  };

  return {
    begin: (request) => connectedAccount.begin(request),
    complete: (request) => connectedAccount.complete(request),
    credentials: (request) => credentials.credentials(request),
    readCredential,
    setDefault: (request, credentialId) =>
      credentials.setDefault(request, credentialId),
    remove: (request, credentialId) =>
      credentials.remove(request, credentialId),
  };
}
