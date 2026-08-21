import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { RestartHandoffStore } from "../session-restart-store.ts";
import { ShutdownInterruptedSessionStore } from "../session-shutdown-interrupted-store.ts";
import {
  emitReportedParent,
  type SessionStoreWriteResources,
} from "../session-store-resources.ts";

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

test("shared parent-report delivery invokes its live-parent callback", () => {
  const reportParent = vi.fn();
  emitReportedParent(
    { reportParent } satisfies Pick<SessionStoreWriteResources, "reportParent">,
    "user",
    report,
  );
  expect(reportParent).toHaveBeenCalledWith("user", report);
});

const sharedDeliveryCallers = [
  [
    "session-store-queue.ts",
    "emitReportedParent(resources, userId, status.report);",
  ],
  [
    "session-store-reassignment.ts",
    "emitReportedParent(options.resources, options.userId, status.reportedParent);",
  ],
  [
    "session-provider-update-store.ts",
    "emitReportedParent(resources, input.userId, changed.reportedParent);",
  ],
  [
    "session-tool-update-store.ts",
    "emitReportedParent(options, input.userId, changed.reportedParent);",
  ],
  ["runner-store.ts", "emitReportedParent(this.#context, ownerId, report);"],
] as const;

test.each(sharedDeliveryCallers)(
  "%s hands an advanced terminal report to the shared emitter",
  (file, delivery) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source).toContain(delivery);
  },
);

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
