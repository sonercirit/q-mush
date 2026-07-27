import { expect, test } from "vitest";
import {
  PROMPT_BODY_MAXIMUM_BYTES,
  PROMPT_NAME_MAXIMUM_LENGTH,
  normalizePromptInput,
  promptNameKey,
} from "../../shared/prompt-model.ts";

test("normalizes prompt names without changing prompt bodies", () => {
  const body = "  First line\n  Second line  ";
  expect(
    normalizePromptInput({
      body,
      name: " \tＲｅｌｅａｓｅ\u00a0\n checklist ",
    }),
  ).toEqual({ body, name: "Release checklist" });
  expect(promptNameKey("ＲＥＬＥＡＳＥ   CHECKLIST")).toBe("release checklist");
});

test("rejects blank and overlong prompt input", () => {
  const invalid = [
    { body: "", name: "Name" },
    { body: " \n\t ", name: "Name" },
    { body: "Body", name: " \n\t " },
    { body: "é".repeat(PROMPT_BODY_MAXIMUM_BYTES / 2 + 1), name: "Name" },
    { body: "Body", name: "x".repeat(PROMPT_NAME_MAXIMUM_LENGTH + 1) },
  ];
  expect(invalid.map(normalizePromptInput)).toEqual(
    invalid.map(() => undefined),
  );
});
