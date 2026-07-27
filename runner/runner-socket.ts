import { parseJsonRecord } from "../shared/json-record.ts";
import { RunnerConnectionError } from "./runner-connection.ts";

function parseOptionalRecord<Message extends Readonly<Record<string, unknown>>>(
  parse: (message: string) => Message,
  message: string,
): Message | undefined {
  try {
    return parse(message);
  } catch {
    return undefined;
  }
}

export function parseSocketJsonRecord(
  message: string,
): Readonly<Record<string, unknown>> | undefined {
  return parseOptionalRecord(
    (value) => parseJsonRecord(value, "The server returned an invalid message"),
    message,
  );
}

export function addRunnerSocketFailureListeners(
  socket: Pick<WebSocket, "addEventListener">,
  settle: (error: Error) => void,
  messages: Readonly<{ readonly close: string; readonly error: string }>,
): void {
  for (const [type, message] of [
    ["error", messages.error],
    ["close", messages.close],
  ] as const) {
    socket.addEventListener(
      type,
      () => {
        settle(new RunnerConnectionError(message));
      },
      { once: true },
    );
  }
}
