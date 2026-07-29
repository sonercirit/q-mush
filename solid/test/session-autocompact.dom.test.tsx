import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionStatus } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  disposeTestViews,
  findTestButton,
  queryTestElement,
} from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { mountSessionDetailBody } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals = new Array<() => void>();

afterEach(() => {
  disposeTestViews(disposals);
});

function compactButton(
  container: ParentNode,
  label: "Compact and continue" | "Compact",
): HTMLButtonElement | undefined {
  return findTestButton(container, label);
}

function expectNoCompactAndContinue(container: ParentNode): void {
  expect(compactButton(container, "Compact and continue")).toBeUndefined();
}

function mountCompactionControls(status: AgentSessionStatus) {
  const detail = { ...TEST_SESSION_DETAIL, status };
  const command = vi.fn(
    (operation: string, payload: Readonly<Record<string, unknown>>) => {
      const autoCompact = payload["autoCompact"];
      if (
        operation === SESSION_REALTIME_OPERATIONS.setAutoCompaction &&
        typeof autoCompact === "boolean"
      ) {
        return Promise.resolve({
          ...detail,
          autoCompact,
          updatedAt: detail.updatedAt + 1,
        });
      }
      if (
        operation === SESSION_REALTIME_OPERATIONS.compact ||
        operation === SESSION_REALTIME_OPERATIONS.compactAndContinue
      ) {
        return Promise.resolve({
          ...detail,
          generation: detail.generation + 1,
          status: "queued" as const,
          updatedAt: detail.updatedAt + 1,
        });
      }
      return Promise.reject(new Error("Unexpected session command"));
    },
  );
  const mounted = mountSessionDetailBody(
    sessionDetailState(detail),
    disposals,
    { command },
  );
  const autoCompact = queryTestElement(
    mounted.container,
    "#session-auto-compact",
  );
  if (!(autoCompact instanceof HTMLInputElement)) {
    throw new TypeError("The auto-compaction control is not a checkbox");
  }
  return { ...mounted, autoCompact, command, detail };
}

function expectAutoCompactUpdate(options: {
  readonly command: ReturnType<typeof vi.fn>;
  readonly controller: ReturnType<typeof mountCompactionControls>["controller"];
  readonly sessionId: string;
}): void {
  expect(options.command).toHaveBeenCalledWith(
    SESSION_REALTIME_OPERATIONS.setAutoCompaction,
    { autoCompact: false, sessionId: options.sessionId },
  );
  expect(options.controller.state.detail?.autoCompact).toBe(false);
}

async function toggleAutoCompaction(
  mounted: ReturnType<typeof mountCompactionControls>,
): Promise<void> {
  mounted.autoCompact.click();
  await vi.waitFor(() => {
    expectAutoCompactUpdate({
      command: mounted.command,
      controller: mounted.controller,
      sessionId: mounted.detail.id,
    });
  });
}

test.each(["queued", "running", "paused"] as const)(
  "keeps auto-compaction available while a session is $status",
  (status) => {
    const { autoCompact, container } = mountCompactionControls(status);

    expect(autoCompact.disabled).toBe(false);
    expect(compactButton(container, "Compact")).toBeUndefined();
    expectNoCompactAndContinue(container);
  },
);

test("persists auto-compaction changes while a session is running", async () => {
  const mounted = mountCompactionControls("running");
  await toggleAutoCompaction(mounted);
});

test.each(["failed", "stopped"] as const)(
  "shows only Compact for a $status session",
  async (status) => {
    const { command, container, controller } = mountCompactionControls(status);

    expect(compactButton(container, "Compact")?.disabled).toBe(false);
    expectNoCompactAndContinue(container);
    await controller.compact(true);
    expect(command).not.toHaveBeenCalled();
  },
);

test("keeps idle auto-compaction behavior and manual compaction access", async () => {
  const mounted = mountCompactionControls("idle");

  expect(mounted.autoCompact.disabled).toBe(false);
  expect(compactButton(mounted.container, "Compact")?.disabled).toBe(false);
  expect(
    compactButton(mounted.container, "Compact and continue")?.disabled,
  ).toBe(false);

  await toggleAutoCompaction(mounted);
});

test.each([
  ["Compact", SESSION_REALTIME_OPERATIONS.compact],
  ["Compact and continue", SESSION_REALTIME_OPERATIONS.compactAndContinue],
] as const)("sends %s without a user message", async (label, operation) => {
  const mounted = mountCompactionControls("idle");

  compactButton(mounted.container, label)?.click();

  await vi.waitFor(() => {
    expect(mounted.command).toHaveBeenCalledWith(operation, {
      sessionId: mounted.detail.id,
    });
  });
});
