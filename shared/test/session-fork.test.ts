import { expect, test } from "vitest";
import {
  readSessionForkInput,
  type SessionForkInput,
} from "../session-fork.ts";
import { TEST_SESSION_FORK_SELECTION } from "./session-fork-fixtures.ts";

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

test("reads an optional fork provider and model selection", () => {
  const input = {
    ...VALID_INPUT,
    ...TEST_SESSION_FORK_SELECTION,
  } as const satisfies SessionForkInput;

  expect(readSessionForkInput(input)).toEqual(input);
  expect(
    readSessionForkInput({ ...input, reasoningEffort: null }),
  ).toMatchObject({ reasoningEffort: null });
});

test.each([
  { credentialId: "credential-2" },
  {
    credentialId: "credential-2",
    model: "bad model",
    provider: "openrouter",
  },
  {
    credentialId: "credential-2",
    model: "openai/gpt-5",
    provider: "unknown",
  },
  {
    credentialId: "credential-2",
    model: "openai/gpt-5",
    provider: "openrouter",
    reasoningEffort: "extreme",
  },
])("rejects an invalid fork provider selection", (selection) => {
  expect(
    readSessionForkInput({ ...VALID_INPUT, ...selection }),
  ).toBeUndefined();
});

test.each([
  { ...VALID_INPUT, forkPointMessageId: "message/1" },
  { ...VALID_INPUT, sourceSessionId: "" },
  { ...VALID_INPUT, workspaceId: "workspace 1" },
])("rejects invalid session fork identifiers", (input) => {
  expect(readSessionForkInput(input)).toBeUndefined();
});
