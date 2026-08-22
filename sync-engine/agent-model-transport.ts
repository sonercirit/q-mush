import { createServerWebSocket } from "../shared/server-websocket.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export function headersRecord(
  headers: Headers,
): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
}

export function defaultAgentModelWebSocket(
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) {
  return createServerWebSocket(url, options.headers);
}

export function emptyOutputDelta(): ProviderTextDelta {
  return { content: "", reset: true, thinking: "" };
}
