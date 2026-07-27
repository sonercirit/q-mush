import { expect, test } from "vitest";
import { RunnerConnectionError } from "../../runner/runner-connection.ts";
import { completeRunnerRegistration } from "../../runner/runner-registration.ts";
import {
  RunnerStartupRestart,
  type RunnerStartupConnection,
} from "../../runner/runner-update.ts";
import { RecordingTestSocket } from "../../shared/test/websocket-fixtures.ts";

class RegistrationSocket extends RecordingTestSocket {}

interface RegistrationSetup {
  readonly connection: RunnerStartupConnection;
  readonly installed: string[];
  readonly promise: Promise<void>;
  readonly socket: RegistrationSocket;
  readonly startup: RunnerStartupRestart;
}

function registrationForStartup(
  startup: RunnerStartupRestart,
  installed: string[],
  installation: string,
  onVersion?: (version: string) => void,
): RegistrationSetup {
  const socket = new RegistrationSocket();
  const connection = startup.connection();
  const promise = completeRunnerRegistration(
    socket,
    connection,
    () => {
      installed.push(installation);
    },
    onVersion,
  );
  return { connection, installed, promise, socket, startup };
}

function registration(
  restartId: string | null = "restart-client",
  onVersion?: (version: string) => void,
): RegistrationSetup {
  return registrationForStartup(
    new RunnerStartupRestart(restartId ?? undefined),
    [],
    "operational",
    onVersion,
  );
}

function ready(registrationId: string) {
  return {
    registrationId,
    runnerId: "runner-1",
    type: "registration_ready",
    version: "runner-version",
  };
}

function committed(registrationId: string) {
  return { registrationId, type: "registration_committed" };
}

function active(registrationId: string, activationReceipt = "receipt-1") {
  return {
    activationReceipt,
    registrationId,
    type: "registration_active",
  };
}

function finalized(registrationId: string, activationReceipt = "receipt-1") {
  return {
    activationReceipt,
    registrationId,
    type: "registration_finalized",
  };
}

function operational(registrationId: string) {
  return { registrationId, type: "registration_operational" };
}

function receiveThroughFinalized(
  setup: RegistrationSetup,
  registrationId: string,
  receipt = "receipt-1",
): void {
  setup.socket.receive(ready(registrationId));
  setup.socket.receive(committed(registrationId));
  setup.socket.receive(active(registrationId, receipt));
  setup.socket.receive(finalized(registrationId, receipt));
}

function invalidRegistrationError() {
  return new RunnerConnectionError("The server returned invalid setup data");
}

async function expectInvalidPromise(setup: RegistrationSetup): Promise<void> {
  await expect(setup.promise).rejects.toEqual(invalidRegistrationError());
}

async function expectInvalidRegistration(
  frame: unknown,
  setup: RegistrationSetup,
): Promise<void> {
  setup.socket.receive(frame);
  await expectInvalidPromise(setup);
}

function expectLastAcknowledgement(
  setup: RegistrationSetup,
  registrationId: string,
  type: "registration_finalized_received" | "registration_operational_received",
): void {
  expect(setup.socket.sent.at(-1)).toBe(
    JSON.stringify({ registrationId, type }),
  );
}

function finalizedRestartState(
  setup: RegistrationSetup,
  activationReceipt: string,
): void {
  expect(setup.startup.connection()).toMatchObject({
    activationReceipt,
    activationReceiptPhase: "finalized",
    restartId: "restart-client",
  });
}

function installedOperationally(setup: RegistrationSetup): void {
  expect(setup.installed).toEqual(["operational"]);
}

function registrationTest(
  name: string,
  action: (setup: RegistrationSetup) => Promise<void> | void,
): void {
  test(name, async () => {
    await action(registration());
  });
}

test("reports the proposed server runner version", () => {
  const versions: string[] = [];
  const setup = registration(null, (version) => {
    versions.push(version);
  });

  setup.socket.receive(ready("registration-version"));

  expect(versions).toEqual(["runner-version"]);
});

registrationTest("rejects mismatched registration IDs", async (setup) => {
  setup.socket.receive(ready("registration-1"));

  await expectInvalidRegistration(committed("registration-other"), setup);
  expect(setup.socket.sent).toEqual([
    JSON.stringify({
      registrationId: "registration-1",
      type: "registration_accept",
    }),
  ]);
  expect(setup.startup.restartId).toBe("restart-client");
});

test("rejects duplicate and out-of-order registration stages", async () => {
  const duplicate = registration();
  duplicate.socket.receive(ready("registration-duplicate"));
  await expectInvalidRegistration(ready("registration-duplicate"), duplicate);

  const outOfOrder = registration();
  await expectInvalidRegistration(
    committed("registration-out-of-order"),
    outOfOrder,
  );
});

registrationTest(
  "retains a prepared receipt when the active acknowledgement send throws",
  async (setup) => {
    setup.socket.receive(ready("registration-send"));
    setup.socket.receive(committed("registration-send"));
    setup.socket.throwOnSend = true;
    setup.socket.receive(active("registration-send", "receipt-prepared"));

    await expect(setup.promise).rejects.toEqual(
      new RunnerConnectionError(
        "The WebSocket registration acknowledgement failed",
      ),
    );
    expect(setup.startup.connection()).toMatchObject({
      activationReceipt: "receipt-prepared",
      activationReceiptPhase: "prepared",
      restartId: "restart-client",
    });
  },
);

test("stores final receipt but does not consume restart identity on a pre-operational frame", () => {
  const setup = registration();
  receiveThroughFinalized(
    setup,
    "registration-pre-operational",
    "receipt-finalized",
  );

  expectLastAcknowledgement(
    setup,
    "registration-pre-operational",
    "registration_finalized_received",
  );
  expect(setup.installed).toEqual([]);
  finalizedRestartState(setup, "receipt-finalized");
});

test("installs command handling before operational acknowledgement and resolution", async () => {
  const setup = registration();
  receiveThroughFinalized(setup, "registration-operational", "receipt-final");
  setup.socket.receive(operational("registration-operational"));

  await expect(setup.promise).resolves.toBeUndefined();

  installedOperationally(setup);
  expectLastAcknowledgement(
    setup,
    "registration-operational",
    "registration_operational_received",
  );
  expect(setup.startup.restartId).toBeUndefined();
  expect(setup.startup.activationReceipt).toBeUndefined();
});

test("a completed registration can reconnect with its retained receipt", async () => {
  const first = registration(null);
  receiveThroughFinalized(first, "registration-first", "receipt-reconnect");
  first.socket.receive(operational("registration-first"));
  await expect(first.promise).resolves.toBeUndefined();

  const reconnect = registrationForStartup(first.startup, [], "reconnected");

  expect(reconnect.connection).toMatchObject({
    activationReceipt: "receipt-reconnect",
    activationReceiptPhase: "finalized",
  });
  reconnect.socket.receive(ready("registration-reconnect"));
  reconnect.socket.receive(committed("registration-reconnect"));
  reconnect.socket.receive(
    active("registration-reconnect", "receipt-reconnect"),
  );
  reconnect.socket.receive(
    finalized("registration-reconnect", "receipt-reconnect"),
  );
  reconnect.socket.receive(operational("registration-reconnect"));

  await expect(reconnect.promise).resolves.toBeUndefined();
  expect(reconnect.installed).toEqual(["reconnected"]);
  expect(first.connection.operational("receipt-reconnect")).toBe(false);
});

test("retains finalized restart state when operational acknowledgement throws", async () => {
  const setup = registration();
  receiveThroughFinalized(
    setup,
    "registration-operational-send",
    "receipt-finalized",
  );
  setup.socket.throwOnSend = true;
  setup.socket.receive(operational("registration-operational-send"));

  await expect(setup.promise).rejects.toBeInstanceOf(RunnerConnectionError);

  installedOperationally(setup);
  finalizedRestartState(setup, "receipt-finalized");
});

test("does not install handlers when finalized activation ownership is lost", async () => {
  const setup = registration();
  setup.socket.receive(ready("registration-stale-operational"));
  setup.socket.receive(committed("registration-stale-operational"));
  setup.socket.receive(active("registration-stale-operational", "receipt-one"));
  setup.startup.restoreActivation("receipt-other", "finalized");
  setup.socket.receive(
    finalized("registration-stale-operational", "receipt-one"),
  );

  await expectInvalidPromise(setup);

  expect(setup.installed).toEqual([]);
  expect(setup.startup.connection()).toMatchObject({
    activationReceipt: "receipt-other",
    activationReceiptPhase: "finalized",
    restartId: "restart-client",
  });
});

test("preserves an ordinary finalized receipt without inventing restart metadata", () => {
  const setup = registration(null);
  receiveThroughFinalized(setup, "registration-ordinary", "ordinary-receipt");

  expect(setup.startup.connection()).toMatchObject({
    activationReceipt: "ordinary-receipt",
    activationReceiptPhase: "finalized",
  });
  expect(setup.startup.restartId).toBeUndefined();
});
