import { isRecord } from "../shared/auth-model.ts";
import { ProviderCredentialReauthenticationRequiredError } from "./provider-error.ts";

const TERMINAL_OPENAI_REFRESH_CODES = new Set([
  "invalid_client",
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export async function openAiRefreshReauthenticationError(
  response: Response,
): Promise<ProviderCredentialReauthenticationRequiredError | undefined> {
  if (response.status === 401 || response.status === 403) {
    return new ProviderCredentialReauthenticationRequiredError(
      "OpenAI",
      response.status,
    );
  }
  if (response.status !== 400) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const code = isRecord(body) ? body["error"] : undefined;
  const nestedCode = isRecord(code) ? code["code"] : undefined;
  const terminalCode = typeof code === "string" ? code : nestedCode;
  return typeof terminalCode === "string" &&
    TERMINAL_OPENAI_REFRESH_CODES.has(terminalCode)
    ? new ProviderCredentialReauthenticationRequiredError("OpenAI", 400)
    : undefined;
}
