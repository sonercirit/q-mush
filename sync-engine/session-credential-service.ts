import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  readSessionCredential,
  withSessionCredential,
  type SessionCredentialAction,
  type SessionCredentialRead,
  type SessionCredentialSelection,
} from "./session-credential-access.ts";
import type { SessionCredentialReaders } from "./session-credential-readers.ts";

export class SessionCredentialAccess {
  readonly #providers: SessionCredentialReaders;

  constructor(providers: SessionCredentialReaders) {
    this.#providers = providers;
  }

  readonly readForSession: SessionCredentialRead = (
    userId,
    selection,
    refresh,
  ) => readSessionCredential(this.#providers, userId, selection, refresh);

  readonly read = async (
    userId: string,
    selection: SessionCredentialSelection,
  ): Promise<ProviderCredentialAccess | undefined> =>
    readSessionCredential(this.#providers, userId, selection);

  readonly with = (
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ): Promise<Response> =>
    withSessionCredential(this.#providers, userId, selection, action);
}
