import type { ProviderId } from "../shared/provider-id.ts";
import {
  BRAVE_SEARCH_KEYS_PATH,
  GENERIC_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_PATH,
} from "../shared/routes.ts";

type BrowserProviderId = "brave-search" | ProviderId;

export interface ProviderPanelConfiguration {
  readonly accountIdUnavailable: string;
  readonly apiFormatSelectable?: boolean;
  readonly baseUrlPlaceholder?: string;
  readonly connectLabel?: string;
  readonly credentialsPath: string;
  readonly description: string;
  readonly emptyMessage: string;
  readonly id: BrowserProviderId;
  readonly keyPlaceholder: string;
  readonly keyRequired?: boolean;
  readonly keyRequiresLabel?: boolean;
  readonly name: string;
  readonly oauthPath?: string;
  readonly quotaSupported?: boolean;
  readonly removalHelp: string;
}

export const GENERIC_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "Compatible API endpoint",
  apiFormatSelectable: true,
  baseUrlPlaceholder: "http://localhost:11434/v1",
  credentialsPath: GENERIC_CREDENTIALS_PATH,
  description:
    "Connect any OpenAI-compatible chat-completions endpoint or Anthropic-compatible messages endpoint. Q Mush stores its API base URL and encrypts the optional API key locally.",
  emptyMessage:
    "No generic providers yet. Add a compatible API base URL and an API key when that endpoint requires one.",
  id: "generic",
  keyPlaceholder: "Optional API key",
  keyRequired: false,
  keyRequiresLabel: true,
  name: "Generic LLM",
  quotaSupported: false,
  removalHelp:
    "Removing a provider clears its encrypted local key. It does not change or revoke access at the remote endpoint.",
};

export const OPENAI_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "OpenAI account ID unavailable",
  connectLabel: "Connect OpenAI account",
  credentialsPath: OPENAI_CREDENTIALS_PATH,
  description:
    "Connect multiple OpenAI accounts with OAuth or save multiple API keys. Credentials stay encrypted in the local database.",
  emptyMessage:
    "No OpenAI accounts or keys yet. Connect an account or add as many keys as you need.",
  id: "openai",
  keyPlaceholder: "sk-…",
  name: "OpenAI",
  oauthPath: OPENAI_OAUTH_PATH,
  removalHelp:
    "Removing a credential only removes the local copy. Revoke connected access in OpenAI if you no longer want it to exist there.",
};

export const OPENROUTER_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "OpenRouter account ID unavailable",
  connectLabel: "Connect OpenRouter account",
  credentialsPath: OPENROUTER_CREDENTIALS_PATH,
  description:
    "Connect multiple OpenRouter accounts with OAuth or save multiple API keys. Credentials stay encrypted in the local database.",
  emptyMessage:
    "No OpenRouter accounts or keys yet. Connect an account or add as many keys as you need.",
  id: "openrouter",
  keyPlaceholder: "sk-or-v1-…",
  name: "OpenRouter",
  oauthPath: OPENROUTER_OAUTH_PATH,
  removalHelp:
    "Removing a credential only removes the local copy. Revoke OAuth-created keys from OpenRouter if you no longer want them to exist there.",
};

export const BRAVE_SEARCH_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "Available to the Brave Search agent skill",
  credentialsPath: BRAVE_SEARCH_KEYS_PATH,
  description:
    "Give agents server-side web search without exposing keys to the browser, model provider, or runner. Keys stay encrypted in the local database.",
  emptyMessage:
    "No Brave Search keys yet. Add as many keys as you need; the skill can try another saved key when one is unavailable.",
  id: "brave-search",
  keyPlaceholder: "BSA…",
  keyRequiresLabel: true,
  name: "Brave Search",
  removalHelp:
    "Removing a key clears the encrypted local copy. Revoke it in Brave if it should no longer work outside Q Mush.",
};
