import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  ProviderQuotaResetOutcome,
  ProviderQuotaSnapshot,
} from "../shared/provider-quota.ts";
import { requireRecord } from "../shared/validation.ts";
import {
  agentProviderRequestHeaders,
  setChatGptAccountHeader,
} from "./agent-model.ts";
import type { OAuthRuntime } from "./oauth.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import {
  readCodexQuota,
  readOpenAiKeyQuota,
  readOpenRouterQuota,
} from "./provider-quota-parsers.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const OPENAI_KEY_METADATA_URL = "https://api.openai.com/v1/me";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

export type ProviderQuotaReader = (
  credential: ProviderCredentialAccess,
  threshold: number,
) => Promise<ProviderQuotaSnapshot>;

export type ProviderQuotaResetter = (
  credential: ProviderCredentialAccess,
  requestId: string,
) => Promise<ProviderQuotaResetOutcome>;

async function quotaResponse(
  runtime: OAuthRuntime,
  url: string,
  credential: ProviderCredentialAccess,
): Promise<Response> {
  const headers = agentProviderRequestHeaders(
    credential.source === "oauth" && url === CODEX_USAGE_URL
      ? "openai"
      : url === OPENROUTER_KEY_URL
        ? "openrouter"
        : "openai",
    credential,
    { accept: "application/json" },
  );
  return runtime.fetch(url, { headers });
}

function checkedResponse(response: Response, provider: string): Response {
  if (!response.ok) {
    throw new Error(`${provider} quota request failed`);
  }
  return response;
}

export function createOpenAiQuotaReader(
  runtime: OAuthRuntime,
): ProviderQuotaReader {
  return async (credential, threshold) => {
    if (credential.source === "oauth") {
      const response = checkedResponse(
        await quotaResponse(runtime, CODEX_USAGE_URL, credential),
        "OpenAI",
      );
      return readCodexQuota(await response.json(), threshold, runtime.now());
    }
    const response = checkedResponse(
      await quotaResponse(runtime, OPENAI_KEY_METADATA_URL, credential),
      "OpenAI",
    );
    await response.body?.cancel();
    return readOpenAiKeyQuota(response.headers, threshold, runtime.now());
  };
}

export function createOpenRouterQuotaReader(
  runtime: OAuthRuntime,
): ProviderQuotaReader {
  return async (credential, threshold) => {
    const response = checkedResponse(
      await quotaResponse(runtime, OPENROUTER_KEY_URL, credential),
      "OpenRouter",
    );
    return readOpenRouterQuota(await response.json(), threshold, runtime.now());
  };
}

export function createCodexQuotaResetter(
  runtime: OAuthRuntime,
): ProviderQuotaResetter {
  return async (credential, requestId) => {
    if (credential.source !== "oauth") {
      return "nothing_to_reset";
    }
    const stored = readOpenAiOAuthCredential(credential.secret);
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${stored.access}`,
      "content-type": "application/json",
      originator: "q_mush",
    });
    setChatGptAccountHeader(headers, credential.accountId);
    const response = checkedResponse(
      await runtime.fetch(CODEX_RESET_URL, {
        body: JSON.stringify({ redeem_request_id: requestId }),
        headers,
        method: "POST",
      }),
      "OpenAI",
    );
    const value = requireRecord(
      await response.json(),
      "OpenAI returned an invalid reset result",
    );
    const code = value["code"];
    if (
      code !== "reset" &&
      code !== "nothing_to_reset" &&
      code !== "no_credit" &&
      code !== "already_redeemed"
    ) {
      throw new Error("OpenAI returned an invalid reset result");
    }
    return code;
  };
}

export const unsupportedQuotaReset: ProviderQuotaResetter = () =>
  Promise.resolve("nothing_to_reset");
