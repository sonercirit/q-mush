import { expect, test } from "vitest";
import { CompactionPreviewCard } from "../../solid/session-compaction-preview.tsx";
import type { CompactionPreview } from "../../solid/session-compaction-state.ts";
import { renderSolidToString } from "./render-solid.tsx";

const PREVIEW: CompactionPreview = {
  attempt: 1,
  operationId: "operation-1",
  reasoning: "I checked the relevant constraints.",
  reasoningTruncated: false,
  sequence: 4,
  sessionId: "session-1",
  summary: "Keep the focused implementation.",
  summaryTruncated: false,
};

test("renders an accessible temporary compaction preview with separate output", () => {
  const html = renderSolidToString(() => (
    <CompactionPreviewCard preview={PREVIEW} />
  ));

  expect(html).toContain("Compacting conversation");
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="off"');
  expect(html).toContain(
    "Temporary preview. It is not part of the transcript.",
  );
  expect(html).toContain("Summary preview");
  expect(html).toContain("Keep the focused implementation.");
  expect(html).toContain("Compaction reasoning");
  expect(html).toContain("I checked the relevant constraints.");
});

test("marks bounded preview truncation", () => {
  const html = renderSolidToString(() => (
    <CompactionPreviewCard preview={{ ...PREVIEW, summaryTruncated: true }} />
  ));

  expect(html).toContain("Earlier preview output was truncated.");
});
