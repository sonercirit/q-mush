import {
  runnerRegistrationAcceptMessage,
  runnerRegistrationActiveReceivedMessage,
  runnerRegistrationFinalizedReceivedMessage,
  runnerRegistrationOperationalReceivedMessage,
  runnerRegistrationReceivedMessage,
} from "../shared/runner-realtime-protocol.ts";
import {
  createRunnerConnectionSettlement,
  RunnerConnectionError,
} from "./runner-connection.ts";
import {
  addRunnerSocketFailureListeners,
  parseSocketJsonRecord,
  RunnerRegistrationRejectedError,
} from "./runner-socket.ts";
import type { RunnerStartupConnection } from "./runner-update.ts";

const parseRunnerRegistrationMessage = parseSocketJsonRecord;

type RegistrationServerType =
  | "registration_active"
  | "registration_committed"
  | "registration_finalized"
  | "registration_operational"
  | "registration_ready";

function registrationMessage(
  message: Readonly<Record<string, unknown>>,
  expectedType: RegistrationServerType,
): string | undefined {
  const registrationId = message["registrationId"];
  const activationReceipt = message["activationReceipt"];
  const hasReceipt =
    expectedType === "registration_active" ||
    expectedType === "registration_finalized";
  const expectedKeys =
    expectedType === "registration_ready"
      ? ["registrationId", "runnerId", "type", "version"]
      : hasReceipt
        ? ["activationReceipt", "registrationId", "type"]
        : ["registrationId", "type"];
  return message["type"] === expectedType &&
    typeof registrationId === "string" &&
    registrationId.length > 0 &&
    registrationId.length <= 200 &&
    (!hasReceipt ||
      (typeof activationReceipt === "string" &&
        activationReceipt.length > 0 &&
        activationReceipt.length <= 200)) &&
    Object.keys(message).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(message, key))
    ? registrationId
    : undefined;
}

interface RunnerRegistrationSocket {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  send(message: string): void;
}

type RegistrationStage =
  "active" | "committed" | "finalized" | "operational" | "ready";

interface RegistrationState {
  pendingReceipt: string | undefined;
  registrationId: string | undefined;
  stage: RegistrationStage;
}

interface RegistrationContext {
  readonly installOperationalHandlers: () => void;
  readonly onOperational:
    ((restartId: string | undefined) => boolean) | undefined;
  readonly onVersion: ((version: string) => void) | undefined;
  readonly send: (message: string) => boolean;
  readonly settle: (error?: RunnerConnectionError) => void;
  readonly startupConnection: RunnerStartupConnection;
  readonly state: RegistrationState;
}

function invalidRegistration(context: RegistrationContext): void {
  context.settle(
    new RunnerConnectionError("The server returned invalid setup data"),
  );
}

const registrationStages: Readonly<
  Record<RegistrationServerType, RegistrationStage>
> = {
  registration_active: "active",
  registration_committed: "committed",
  registration_finalized: "finalized",
  registration_operational: "operational",
  registration_ready: "ready",
};

function expectedRegistrationStage(
  type: RegistrationServerType,
): RegistrationStage {
  return registrationStages[type];
}

function registrationTransition(
  context: RegistrationContext,
  message: Readonly<Record<string, unknown>>,
):
  | Readonly<{
      registrationId: string;
      type: RegistrationServerType;
    }>
  | undefined {
  const type = message["type"];
  if (
    type !== "registration_active" &&
    type !== "registration_committed" &&
    type !== "registration_finalized" &&
    type !== "registration_operational" &&
    type !== "registration_ready"
  ) {
    invalidRegistration(context);
    return undefined;
  }

  const registrationId = registrationMessage(message, type);
  if (
    context.state.stage !== expectedRegistrationStage(type) ||
    registrationId === undefined ||
    (context.state.registrationId !== undefined &&
      registrationId !== context.state.registrationId)
  ) {
    invalidRegistration(context);
    return undefined;
  }
  return { registrationId, type };
}

function acknowledgeRegistration(
  context: RegistrationContext,
  registrationId: string,
  acknowledgement: string,
  nextStage: RegistrationStage,
): boolean {
  if (!context.send(acknowledgement)) {
    return false;
  }

  context.state.registrationId = registrationId;
  context.state.stage = nextStage;
  return true;
}

function validReadyMessage(
  message: Readonly<Record<string, unknown>>,
): message is Readonly<Record<"runnerId" | "version", string>> {
  return (
    typeof message["runnerId"] === "string" &&
    message["runnerId"].length > 0 &&
    message["runnerId"].length <= 200 &&
    typeof message["version"] === "string" &&
    message["version"].length > 0 &&
    message["version"].length <= 200
  );
}

type RegistrationHandler = (
  context: RegistrationContext,
  message: Readonly<Record<string, unknown>>,
  registrationId: string,
) => void;

const registrationHandlers: Readonly<
  Record<RegistrationServerType, RegistrationHandler>
> = {
  registration_ready: (context, message, registrationId) => {
    if (!validReadyMessage(message)) {
      invalidRegistration(context);
      return;
    }
    if (
      acknowledgeRegistration(
        context,
        registrationId,
        runnerRegistrationAcceptMessage(registrationId),
        "committed",
      )
    ) {
      context.onVersion?.(message.version);
    }
    return;
  },
  registration_committed: (context, _message, registrationId) => {
    acknowledgeRegistration(
      context,
      registrationId,
      runnerRegistrationReceivedMessage(registrationId),
      "active",
    );
    return;
  },
  registration_active: (context, message, registrationId) => {
    const activationReceipt = message["activationReceipt"];
    if (
      typeof activationReceipt !== "string" ||
      !context.startupConnection.prepareActivation(activationReceipt)
    ) {
      invalidRegistration(context);
      return;
    }
    context.state.pendingReceipt = activationReceipt;
    acknowledgeRegistration(
      context,
      registrationId,
      runnerRegistrationActiveReceivedMessage(registrationId),
      "finalized",
    );
    return;
  },
  registration_finalized: (context, message, registrationId) => {
    const activationReceipt = message["activationReceipt"];
    if (
      typeof activationReceipt !== "string" ||
      activationReceipt !== context.state.pendingReceipt ||
      !context.startupConnection.finalizeActivation(activationReceipt)
    ) {
      invalidRegistration(context);
      return;
    }
    acknowledgeRegistration(
      context,
      registrationId,
      runnerRegistrationFinalizedReceivedMessage(registrationId),
      "operational",
    );
    return;
  },
  registration_operational: (context, _message, registrationId) => {
    const activationReceipt = context.state.pendingReceipt;
    if (
      activationReceipt === undefined ||
      !context.startupConnection.canOperate(activationReceipt)
    ) {
      invalidRegistration(context);
      return;
    }
    try {
      context.installOperationalHandlers();
    } catch {
      context.settle(
        new RunnerConnectionError(
          "The runner command handlers could not be installed",
        ),
      );
      return;
    }
    if (
      !context.send(
        runnerRegistrationOperationalReceivedMessage(registrationId),
      )
    ) {
      return;
    }
    context.state.pendingReceipt = undefined;
    if (!context.startupConnection.operational(activationReceipt)) {
      invalidRegistration(context);
      return;
    }
    if (
      context.onOperational?.(context.startupConnection.restartId) === false
    ) {
      context.settle(
        new RunnerConnectionError("The runner restart settlement was invalid"),
      );
      return;
    }
    context.settle();
  },
};

function receiveRegistrationMessage(
  context: RegistrationContext,
  message: Readonly<Record<string, unknown>>,
): void {
  const transition = registrationTransition(context, message);
  if (transition !== undefined) {
    registrationHandlers[transition.type](
      context,
      message,
      transition.registrationId,
    );
  }
}

export interface RunnerRegistrationHandlers {
  readonly onOperational?: (restartId: string | undefined) => boolean;
  readonly onVersion?: (version: string) => void;
}

export function completeRunnerRegistration(
  socket: RunnerRegistrationSocket,
  startupConnection: RunnerStartupConnection,
  installOperationalHandlers: () => void,
  handlers: RunnerRegistrationHandlers = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const state: RegistrationState = {
      pendingReceipt: undefined,
      registrationId: undefined,
      stage: "ready",
    };
    const settlement = createRunnerConnectionSettlement(resolve, reject);
    let settled = false;
    const settle = (error?: RunnerConnectionError): void => {
      settlement.settle(error);
      settled = settlement.settled;
    };
    const send = (message: string): boolean => {
      if (settled) {
        return false;
      }
      try {
        socket.send(message);
        return true;
      } catch {
        settle(
          new RunnerConnectionError(
            "The WebSocket registration acknowledgement failed",
          ),
        );
        return false;
      }
    };
    const context: RegistrationContext = {
      installOperationalHandlers,
      onOperational: handlers.onOperational,
      onVersion: handlers.onVersion,
      send,
      settle,
      startupConnection,
      state,
    };
    socket.addEventListener("message", (event) => {
      if (
        !settled &&
        event instanceof MessageEvent &&
        typeof event.data === "string"
      ) {
        const message = parseRunnerRegistrationMessage(event.data);
        if (message?.["type"] === "registration_rejected") {
          settle(new RunnerRegistrationRejectedError());
          return;
        }
        if (message === undefined) {
          invalidRegistration(context);
          return;
        }
        receiveRegistrationMessage(context, message);
        return;
      }
      if (!settled) {
        settle(
          new RunnerConnectionError("The server returned binary setup data"),
        );
      }
    });
    addRunnerSocketFailureListeners(socket, settle, {
      close: "The WebSocket connection closed during registration",
      error: "The WebSocket connection failed during registration",
    });
  });
}
