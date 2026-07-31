import { expect, test } from "vitest";
import { modelSupportsAttachmentModality } from "../attachment-fallback.ts";

test("requires explicit model modality metadata", () => {
  expect(modelSupportsAttachmentModality(null, "image")).toBe(false);
  expect(modelSupportsAttachmentModality(["text", "image"], "image")).toBe(
    true,
  );
  expect(modelSupportsAttachmentModality(["text", "file"], "pdf")).toBe(true);
  expect(modelSupportsAttachmentModality(["text"], "pdf")).toBe(false);
});
