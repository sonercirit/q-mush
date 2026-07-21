type WebSocketConstructorWithOptions = new (
  url: string | URL,
  options?: Bun.WebSocketOptions,
) => WebSocket;

function supportsWebSocketOptions(
  value: unknown,
): value is WebSocketConstructorWithOptions {
  return typeof value === "function";
}

export function createServerWebSocket(
  url: string | URL,
  headers: Readonly<Record<string, string>>,
  unsupportedMessage = "The runtime does not support WebSocket options",
): WebSocket {
  const Constructor: unknown = WebSocket;

  if (!supportsWebSocketOptions(Constructor)) {
    throw new Error(unsupportedMessage);
  }

  return new Constructor(url, { headers });
}
