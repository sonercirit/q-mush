import { expect, test } from "vitest";
import {
  normalizedSessionMutationError,
  sessionMutationError,
  sessionMutationOutcomeIsUnknown,
  stopSessionMutation,
} from "../../solid/session-mutations.ts";

test.each([
  "outcome_unknown",
  "command_outcome_unknown",
  Object.assign(new Error("other_error"), {
    code: "command_outcome_unknown",
  }),
  Object.assign(new Error("outcome_unknown"), { code: "other_error" }),
])("normalizes unknown mutation outcome %#", (error) => {
  expect(sessionMutationOutcomeIsUnknown(error)).toBe(true);
  expect(normalizedSessionMutationError(error)).toMatchObject({
    code: "outcome_unknown",
    message: "outcome_unknown",
  });
});

test("includes the graceful tree-stop choice only when selected", () => {
  expect(stopSessionMutation("session-1").payload).toEqual({
    sessionId: "session-1",
  });
  expect(stopSessionMutation("session-1", true).payload).toEqual({
    graceful: true,
    sessionId: "session-1",
  });
});

test("reports aggregate capacity as a definitive local admission failure", () => {
  expect(
    sessionMutationError(
      Object.assign(new Error("command_capacity_exceeded"), {
        code: "command_capacity_exceeded",
      }),
      "send that instruction",
    ),
  ).toContain("too much pending session data");
});
