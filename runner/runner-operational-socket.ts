import type { RunnerCommandExecutions } from "./runner-command-executions.ts";
import { readRunnerCommand } from "./runner-command.ts";
import { parseSocketJsonRecord } from "./runner-socket.ts";

export const bindOperationalRunnerSocket = (
  connected: WebSocket,
  active: RunnerCommandExecutions,
): void => {
  connected.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      connected.close(1003, "Text messages required");
      return;
    }
    const message = parseSocketJsonRecord(event.data);
    if (message === undefined) {
      connected.close(1003, "Invalid server message");
      return;
    }
    if (message["type"] === "superseded") return;
    if (message["type"] === "command") {
      active.execute(
        connected,
        readRunnerCommand({ command: message["command"] }),
      );
    } else if (
      message["type"] === "cancel" &&
      typeof message["commandId"] === "string"
    ) {
      active.cancel(connected, message["commandId"]);
    } else if (
      message["type"] === "result_received" &&
      typeof message["commandId"] === "string"
    ) {
      active.resultReceived(message["commandId"]);
    } else if (message["type"] !== "restart_ready") {
      connected.close(1003, "Invalid server message");
    }
  });
};
