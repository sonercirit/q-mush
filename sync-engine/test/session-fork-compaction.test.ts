import { expect, test, vi } from "vitest";
import type { SessionForkSelection } from "../../shared/session-fork.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { compactChangedSessionFork } from "../session-fork-compaction.ts";

const SOURCE = TEST_SESSION_DETAIL;
const FORK = { ...SOURCE, id: "fork-session" };

function selection(model: string): SessionForkSelection {
  return {
    credentialId: SOURCE.credentialId,
    model,
    provider: SOURCE.provider,
    reasoningEffort: SOURCE.reasoningEffort,
  };
}

test("does not compact a fork with the source provider and model", async () => {
  const compact = vi.fn(() => Promise.resolve(FORK));

  await expect(
    compactChangedSessionFork({
      compact,
      detail: FORK,
      selection: selection(SOURCE.model),
      source: SOURCE,
    }),
  ).resolves.toBe(FORK);
  expect(compact).not.toHaveBeenCalled();
});

test("compacts a fork after its provider or model changes", async () => {
  const compacted = { ...FORK, status: "queued" as const };
  const compact = vi.fn(() => Promise.resolve(compacted));

  await expect(
    compactChangedSessionFork({
      compact,
      detail: FORK,
      selection: selection("replacement-model"),
      source: SOURCE,
    }),
  ).resolves.toBe(compacted);
  expect(compact).toHaveBeenCalledOnce();
});
