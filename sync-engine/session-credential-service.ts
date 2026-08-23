import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  readSessionCredential,
  withSessionCredential,
  type SessionCredentialAction,
  type SessionCredentialRead,
  type SessionCredentialSelection,
} from "./session-credential-access.ts";
import type { SessionCredentialReaders } from "./session-credential-readers.ts";

export interface SessionCredentialAccess {
  readonly readForSession: SessionCredentialRead;
  readonly read: (
    userId: string,
    selection: SessionCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly with: (
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ) => Promise<Response>;
}

export function createSessionCredentialAccess(
  providers: SessionCredentialReaders,
): SessionCredentialAccess {
  return {
    readForSession: (userId, selection, refresh) =>
      readSessionCredential(providers, userId, selection, refresh),
    read: (userId, selection) =>
      readSessionCredential(providers, userId, selection),
    with: (userId, selection, action) =>
      withSessionCredential(providers, userId, selection, action),
  };
}
