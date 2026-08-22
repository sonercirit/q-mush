import type { RealtimeSocket } from "./realtime-hub.ts";
import type { RunnerClientMessage } from "./realtime-protocol.ts";
import {
  closeServerError,
  safeSend,
  type RunnerRestartState,
} from "./realtime-runner-runtime.ts";
import type { RealtimeIntegrationOptions } from "./realtime.ts";

interface RunnerRestartContext {
  readonly options: RealtimeIntegrationOptions;
  readonly restarts: Map<string, RunnerRestartState>;
  readonly runnerId: string;
  readonly socket: RealtimeSocket;
}

function sendRunnerRestartReady(
  context: RunnerRestartContext,
  restart: RunnerRestartState,
): void {
  const { options, restarts, runnerId, socket } = context;
  if (
    !restart.settled ||
    restarts.get(runnerId) !== restart ||
    !options.hub.runnerIsCurrent(runnerId, socket) ||
    options.hub.currentRunner(runnerId) !== socket
  ) {
    return;
  }
  if (
    !safeSend(
      socket,
      JSON.stringify({
        restartId: restart.restartId,
        type: "restart_ready",
      }),
    )
  ) {
    closeServerError(socket, "Runner restart acknowledgement failed");
  }
}

export function handleRunnerRestartRequest(
  context: RunnerRestartContext,
  event: Extract<
    RunnerClientMessage,
    { readonly type: "restart" | "restart_escalate" }
  >,
): void {
  const { options, restarts, runnerId, socket } = context;
  const current = restarts.get(runnerId);
  if (
    current?.restartId !== undefined &&
    current.restartId !== event.restartId
  ) {
    socket.close(1008, "Conflicting runner restart ID");
    return;
  }
  if (event.type === "restart_escalate") {
    if (current === undefined) {
      socket.close(1008, "No runner restart is pending");
      return;
    }
    const escalated = options.sessions.escalateRunnerDrain(
      runnerId,
      event.restartId,
    );
    if (!escalated && !current.settled) {
      socket.close(1008, "No matching runner restart drain is pending");
    } else if (current.settled) {
      sendRunnerRestartReady(context, current);
    }
    return;
  }
  const restart =
    current ??
    (() => {
      const created = {
        promise: options.sessions.drainRunner(runnerId, event.restartId),
        restartId: event.restartId,
        settled: false,
      };
      restarts.set(runnerId, created);
      return created;
    })();
  void restart.promise.then(
    () => {
      restart.settled = true;
      const activeSocket = options.hub.currentRunner(runnerId);
      if (activeSocket !== undefined) {
        sendRunnerRestartReady(
          { options, restarts, runnerId, socket: activeSocket },
          restart,
        );
      }
    },
    () => {
      if (restarts.get(runnerId) === restart) {
        restarts.delete(runnerId);
        closeServerError(socket, "Runner restart handoff failed");
      }
    },
  );
}
