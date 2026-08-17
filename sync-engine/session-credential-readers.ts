import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderCredentialReadArguments } from "./provider-credential-reader.ts";

interface SessionCredentialReader {
  readCredential(
    ...arguments_: ProviderCredentialReadArguments
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<"openai" | "openrouter", SessionCredentialReader> &
    Partial<Record<Extract<ProviderId, "generic">, SessionCredentialReader>>
>;
