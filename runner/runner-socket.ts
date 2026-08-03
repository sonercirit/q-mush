import { parseJsonRecord } from "../shared/json-record.ts";
import { RUNNER_SUPERSEDED_CLOSE_CODE } from "../shared/runner-realtime-protocol.ts";
import { RunnerConnectionError } from "./runner-connection.ts";

export class RunnerSupersededError extends RunnerConnectionError {
  constructor() {
    super("The runner connection was superseded by a newer process");
    this.name = "RunnerSupersededError";
  }
}

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

export function observeOperationalRunnerSocket(
  socket: Pick<WebSocket, "addEventListener">,
): Promise<Error> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (error: Error): void => {
      if (!settled) {
        settled = true;
        resolve(error);
      }
    };
    socket.addEventListener("message", (event) => {
      if (
        event instanceof MessageEvent &&
        typeof event.data === "string" &&
        parseSocketJsonRecord(event.data)?.["type"] === "superseded"
      ) {
        settle(new RunnerSupersededError());
      }
    });
    socket.addEventListener(
      "close",
      (event) => {
        settle(
          event instanceof CloseEvent &&
            event.code === RUNNER_SUPERSEDED_CLOSE_CODE
            ? new RunnerSupersededError()
            : new RunnerConnectionError("The WebSocket connection closed"),
        );
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        settle(new RunnerConnectionError("The WebSocket connection failed"));
      },
      { once: true },
    );
  });
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
