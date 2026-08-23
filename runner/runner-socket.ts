import { parseJsonRecord } from "../shared/json-record.ts";
import { RUNNER_SUPERSEDED_CLOSE_CODE } from "../shared/runner-realtime-protocol.ts";
import {
  createRunnerConnectionError,
  type RunnerConnectionError,
} from "./runner-connection.ts";

export function createRunnerRegistrationRejectedError(): RunnerConnectionError {
  return createRunnerConnectionError(
    "The runner registration was rejected by Q Mush",
    "RunnerRegistrationRejectedError",
  );
}

export function isRunnerRegistrationRejectedError(
  error: unknown,
): error is Error {
  return (
    error instanceof Error && error.name === "RunnerRegistrationRejectedError"
  );
}

export function createRunnerSupersededError(): RunnerConnectionError {
  return createRunnerConnectionError(
    "The runner connection was superseded by a newer process",
    "RunnerSupersededError",
  );
}

export function isRunnerSupersededError(error: unknown): error is Error {
  return error instanceof Error && error.name === "RunnerSupersededError";
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
    return createRunnerRegistrationRejectedError();
  }
  return type === "superseded" ? createRunnerSupersededError() : undefined;
}

function socketCloseFailure(
  event: Event,
  messages: RunnerSocketFailureMessages,
): Error {
  return event instanceof CloseEvent &&
    event.code === RUNNER_SUPERSEDED_CLOSE_CODE
    ? createRunnerSupersededError()
    : createRunnerConnectionError(messages.close);
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
    addRunnerSocketFailureListeners(
      socket,
      (error) => {
        if (!settled) {
          settled = true;
          resolve(error);
        }
      },
      messages,
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
      settle(createRunnerConnectionError(messages.error));
    },
    { once: true },
  );
}
