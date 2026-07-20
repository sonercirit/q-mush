import { describe, expect, test } from "bun:test";
import { RunnerCommandBroker } from "../runner-command-broker.ts";
import { captureRejection } from "./promise-test-helpers.ts";

const RUNNER_ID = "runner-1";
const SESSION_ID = "session-1";

describe("runner command broker", () => {
  test("delivers a tool command only to its runner and resolves its result", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "command-1",
      timeoutMilliseconds: 5_000,
    });
    const command = {
      arguments: { path: "README.md" },
      sessionId: SESSION_ID,
      tool: "read",
      workingDirectory: "/work/project",
    };
    const result = broker.dispatch({ ...command, runnerId: RUNNER_ID });

    expect(broker.take("another-runner")).toBeUndefined();
    expect(broker.take(RUNNER_ID)).toEqual({ ...command, id: "command-1" });
    expect(broker.isActive(RUNNER_ID, "command-1")).toBeTrue();
    expect(broker.complete("another-runner", "command-1", "wrong")).toBeFalse();
    expect(broker.complete(RUNNER_ID, "command-1", "# Q Mush")).toBeTrue();
    expect(broker.isActive(RUNNER_ID, "command-1")).toBeFalse();
    expect(await result).toBe("# Q Mush");
  });

  test("removes queued and in-flight commands when a session is stopped", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "command-2",
      timeoutMilliseconds: 5_000,
    });
    const result = broker.dispatch({
      arguments: { command: "sleep 10" },
      runnerId: RUNNER_ID,
      sessionId: SESSION_ID,
      tool: "bash",
      workingDirectory: "/work/project",
    });
    broker.cancelSession(SESSION_ID);

    expect(broker.take(RUNNER_ID)).toBeUndefined();
    const error = await captureRejection(result);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
