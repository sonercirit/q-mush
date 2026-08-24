import { expect, test } from "vitest";
import {
  createRunnerRegistrationRejectedError,
  observeOperationalRunnerSocket,
} from "../../runner/runner-socket.ts";
import { RUNNER_SUPERSEDED_CLOSE_CODE } from "../../shared/runner-realtime-protocol.ts";
import { createRecordingTestSocket } from "../../shared/test/websocket-fixtures.ts";

function expectSuperseded(failure: Promise<Error>): Promise<void> {
  return expect(failure).resolves.toMatchObject({
    kind: "runner_superseded",
  });
}

function observedSocketFailure(
  message: Readonly<Record<string, unknown>>,
): Promise<Error> {
  const socket = createRecordingTestSocket();
  const failure = observeOperationalRunnerSocket(socket);
  socket.receive(message);
  return failure;
}

test("reports an explicit registration rejection distinctly", () => {
  return expect(
    observedSocketFailure({ type: "registration_rejected" }),
  ).resolves.toEqual(createRunnerRegistrationRejectedError());
});

test("reports an explicit supersession frame distinctly", () => {
  return expectSuperseded(observedSocketFailure({ type: "superseded" }));
});

test("reports a supersession close distinctly when its frame is lost", () => {
  const supersededClose = (): Event =>
    new CloseEvent("close", { code: RUNNER_SUPERSEDED_CLOSE_CODE });
  const socket = createRecordingTestSocket({ closeEvent: supersededClose });
  const failure = observeOperationalRunnerSocket(socket);

  socket.close();

  return expectSuperseded(failure);
});
