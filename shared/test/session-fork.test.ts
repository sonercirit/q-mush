import { expect, test } from "vitest";
import { readSessionForkInput } from "../session-fork.ts";

const VALID_INPUT = {
  forkPointMessageId: "message-1",
  sourceSessionId: "session-1",
  workspaceId: "workspace-1",
} as const;

test("reads an exact session fork input", () => {
  expect(readSessionForkInput(VALID_INPUT)).toEqual(VALID_INPUT);
  expect(
    readSessionForkInput({ ...VALID_INPUT, unexpected: true }),
  ).toBeUndefined();
});

test.each([
  { ...VALID_INPUT, forkPointMessageId: "message/1" },
  { ...VALID_INPUT, sourceSessionId: "" },
  { ...VALID_INPUT, workspaceId: "workspace 1" },
])("rejects invalid session fork identifiers", (input) => {
  expect(readSessionForkInput(input)).toBeUndefined();
});
