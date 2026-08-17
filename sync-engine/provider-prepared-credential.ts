import type {
  ProviderCredentialAccess,
  ProviderCredentialStore,
} from "../shared/provider-credential-store.ts";
import type { OAuthRuntime } from "./oauth.ts";
import type { ProviderCredentialRead } from "./provider-credential-reader.ts";
import { ProviderCredentialReauthenticationRequiredError } from "./provider-error.ts";
import type {
  StoredCredentialReadArguments,
  StoredProviderCredentialAccess,
} from "./provider-stored-credential-access.ts";

export type ProviderCredentialPreparer = (
  runtime: OAuthRuntime,
  credential: ProviderCredentialAccess,
  force?: boolean,
) => Promise<string | undefined>;

interface CredentialPreparation {
  readonly forceRefresh: boolean;
  readonly promise: Promise<boolean>;
  readonly sourceSecret: string;
}

interface PreparedCredentialReaderOptions {
  readonly credentials: StoredProviderCredentialAccess;
  readonly prepareCredential: ProviderCredentialPreparer | undefined;
  readonly runtime: OAuthRuntime;
  readonly store: ProviderCredentialStore | undefined;
}

async function prepareAndPersistCredential(
  options: PreparedCredentialReaderOptions,
  userId: string,
  credentialId: string,
  credential: ProviderCredentialAccess,
  forceRefresh: boolean,
): Promise<boolean> {
  let preparedSecret: string | undefined;
  try {
    preparedSecret = await options.prepareCredential?.(
      options.runtime,
      credential,
      forceRefresh,
    );
  } catch (error) {
    const current = options.credentials.readCredential(userId, credentialId);
    if (current?.secret !== credential.secret) return true;
    if (
      error instanceof ProviderCredentialReauthenticationRequiredError &&
      options.store?.markRequiresReauthentication(
        userId,
        credentialId,
        options.runtime.now(),
      ) !== true
    ) {
      throw new Error("The provider credential is no longer available", {
        cause: error,
      });
    }
    throw error;
  }
  if (preparedSecret === undefined) return false;
  const current = options.credentials.readCredential(userId, credentialId);
  if (current === undefined) {
    throw new Error("The provider credential is no longer available");
  }
  if (current.secret !== credential.secret) return true;
  if (
    !options.credentials.persistSecret(
      userId,
      credentialId,
      preparedSecret,
      options.runtime.now(),
    )
  ) {
    throw new Error("The provider credential is no longer available");
  }
  return true;
}

export function createPreparedCredentialReader(
  options: PreparedCredentialReaderOptions,
): ProviderCredentialRead {
  const preparations = new Map<string, CredentialPreparation>();

  return async (userId, credentialId, workspaceId, refresh) => {
    const forceRefresh = refresh?.force === true;
    const rejectedSecret = refresh?.rejectedSecret;
    const readArguments: StoredCredentialReadArguments =
      workspaceId === undefined
        ? [userId, credentialId]
        : [userId, credentialId, workspaceId];
    const key = `${userId}:${credentialId}`;

    for (;;) {
      const credential = options.credentials.readCredential(...readArguments);
      if (credential === undefined || options.prepareCredential === undefined) {
        return credential;
      }
      if (
        forceRefresh &&
        rejectedSecret !== undefined &&
        credential.secret !== rejectedSecret
      ) {
        return credential;
      }

      const active = preparations.get(key);
      if (active !== undefined) {
        if (active.sourceSecret !== credential.secret) {
          return credential;
        }
        const refreshed = await active.promise;
        if (forceRefresh && !active.forceRefresh && !refreshed) continue;
        return options.credentials.readCredential(...readArguments);
      }

      const promise = prepareAndPersistCredential(
        options,
        userId,
        credentialId,
        credential,
        forceRefresh,
      );
      const preparation = {
        forceRefresh,
        promise,
        sourceSecret: credential.secret,
      };
      preparations.set(key, preparation);
      try {
        await promise;
        return options.credentials.readCredential(...readArguments);
      } finally {
        if (preparations.get(key) === preparation) preparations.delete(key);
      }
    }
  };
}
