import type {
  ProviderCredentialSource,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderLimitObservation } from "../shared/provider-limits.ts";
import {
  parseCodexLimitEvent,
  parseProviderLimitHeaders,
} from "./provider-limit-parsers.ts";

export interface ProviderLimitObserver {
  event(value: unknown, source: "response_event" | "websocket_event"): void;
  response(response: Response): void;
}

export function createProviderLimitObserver(options: {
  readonly credentialSource: ProviderCredentialSource;
  readonly now: () => number;
  readonly observe: (observation: ProviderLimitObservation) => void;
  readonly provider: ProviderId;
}): ProviderLimitObserver {
  return {
    event(value, source) {
      if (
        options.provider !== "openai" ||
        options.credentialSource !== "oauth"
      ) {
        return;
      }
      const parsed = parseCodexLimitEvent(value, options.now());
      if (parsed !== null) {
        options.observe({ ...parsed, source });
      }
    },
    response(response) {
      const parsed = parseProviderLimitHeaders(
        options.provider,
        options.credentialSource,
        response.headers,
        options.now(),
        response.status,
      );
      if (parsed !== null) {
        options.observe(parsed);
      }
    },
  };
}
