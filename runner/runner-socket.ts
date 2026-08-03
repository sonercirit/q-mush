import { parseJsonRecord } from "../shared/json-record.ts";
import { RUNNER_SUPERSEDED_CLOSE_CODE } from "../shared/runner-realtime-protocol.ts";
import { RunnerConnectionError } from "./runner-connection.ts";

export class RunnerRegistrationRejectedError extends RunnerConnectionError {
  constructor() {
    super("The runner registration was rejected by Q Mush");
    this.name = "RunnerRegistrationRejectedError";
  }
}

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

interface RunnerSocketFailureMessages {
  readonly close: string;
  readonly error: string;
}

function socketMessageFailure(event: Event): Error | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return undefined;
  }
  const type = parseSocketJsonRecord(event.data)?.["type"];
  if (type === "registration_rejected") {
    return new RunnerRegistrationRejectedError();
  }
  return type === "superseded" ? new RunnerSupersededError() : undefined;
}

function socketCloseFailure(
  event: Event,
  messages: RunnerSocketFailureMessages,
): Error {
  return event instanceof CloseEvent &&
    event.code === RUNNER_SUPERSEDED_CLOSE_CODE
    ? new RunnerSupersededError()
    : new RunnerConnectionError(messages.close);
}

export function observeOperationalRunnerSocket(
  socket: Pick<WebSocket, "addEventListener">,
): Promise<Error> {
  const messages = {
    close: "The WebSocket connection closed",
    error: "The WebSocket connection failed",
  };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (error: Error): void => {
      if (!settled) {
        settled = true;
        resolve(error);
      }
    };
    socket.addEventListener("message", (event) => {
      const error = socketMessageFailure(event);
      if (error !== undefined) settle(error);
    });
    socket.addEventListener(
      "close",
      (event) => {
        settle(socketCloseFailure(event, messages));
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        settle(new RunnerConnectionError(messages.error));
      },
      { once: true },
    );
  });
}

export function addRunnerSocketFailureListeners(
  socket: Pick<WebSocket, "addEventListener">,
  settle: (error: Error) => void,
  messages: RunnerSocketFailureMessages,
): void {
  socket.addEventListener("message", (event) => {
    const error = socketMessageFailure(event);
    if (error !== undefined) settle(error);
  });
  socket.addEventListener(
    "close",
    (event) => {
      settle(socketCloseFailure(event, messages));
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      settle(new RunnerConnectionError(messages.error));
    },
    { once: true },
  );
}
