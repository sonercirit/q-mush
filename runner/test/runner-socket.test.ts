import { expect, test } from "vitest";
import {
  observeOperationalRunnerSocket,
  RunnerSupersededError,
} from "../../runner/runner-socket.ts";
import { RUNNER_SUPERSEDED_CLOSE_CODE } from "../../shared/runner-realtime-protocol.ts";
import { RecordingTestSocket } from "../../shared/test/websocket-fixtures.ts";

test("reports an explicit supersession frame distinctly", async () => {
  const socket = new RecordingTestSocket();
  const failure = observeOperationalRunnerSocket(socket);

  socket.receive({ type: "superseded" });

  await expect(failure).resolves.toEqual(new RunnerSupersededError());
});

test("reports a supersession close distinctly when its frame is lost", async () => {
  const socket = new RecordingTestSocket({
    closeEvent: () =>
      new CloseEvent("close", { code: RUNNER_SUPERSEDED_CLOSE_CODE }),
  });
  const failure = observeOperationalRunnerSocket(socket);

  socket.close();

  await expect(failure).resolves.toEqual(new RunnerSupersededError());
});
