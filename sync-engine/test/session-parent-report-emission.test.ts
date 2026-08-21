import { expect, test, vi } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { RestartHandoffStore } from "../session-restart-store.ts";
import { ShutdownInterruptedSessionStore } from "../session-shutdown-interrupted-store.ts";

const report = { disposition: "delivered" as const, parentId: "parent" };
const interruptedMarker = Object.assign(
  { executionGeneration: 1, restartId: "restart" },
  { operation: "agent", pendingInput: [], requestedBy: "server" },
);
vi.mock("../session-generation-advance.ts", () => ({
  advanceStoredSessionGeneration: () => ({
    generation: 2,
    reportedParent: report,
    userId: "user",
  }),
}));
vi.mock("../session-store-persistence.ts", () => ({
  activeSessionCondition: () => undefined,
  readActiveSessionTiming: () => ({ activeDurationMs: 0, activeStartedAt: 1 }),
  readStoredSessionSnapshots: () => [
    {
      executionGeneration: 1,
      id: "child",
      interruptedHandoff: JSON.stringify(interruptedMarker),
      restartHandoff: null,
      status: "running",
      userId: "user",
    },
  ],
  sessionGenerationCondition: () => undefined,
  sessionTimingUpdate: () => ({}),
  storedParentExecutionGeneration: () => null,
  storedSessionCondition: () => undefined,
  updateStoredSessions: () => true,
}));
vi.mock("../session-turn-store.ts", () => ({
  activeSessionTurnId: () => undefined,
}));
vi.mock("../session-store-read.ts", () => ({
  appendUnknownRestartToolResults: () => undefined,
}));

test("restart pause emits its generation advance parent report", () => {
  const reportParent = vi.fn();
  const store = new RestartHandoffStore({
    database: createDatabase(":memory:"),
    generateId: () => "message",
    read: () => undefined,
    reportParent,
  });

  expect(
    store.pauseRunning(
      { generation: 1, sessionId: "child" },
      "server",
      "restart",
      "agent",
      2,
    ),
  ).toBe(true);
  expect(reportParent).toHaveBeenCalledWith("user", report);
});

test("shutdown restoration emits its generation advance parent report", () => {
  const reportParent = vi.fn();
  const store = new ShutdownInterruptedSessionStore({
    database: createDatabase(":memory:"),
    generateId: () => "message",
    reportParent,
  });

  store.restore(2);
  expect(reportParent).toHaveBeenCalledWith("user", report);
});
