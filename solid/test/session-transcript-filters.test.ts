import { expect, test } from "vitest";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  readSessionTranscriptFilters,
  writeSessionTranscriptFilters,
  type SessionTranscriptFilterStorage,
} from "../session-transcript-filters.ts";
import { createMemoryStorage } from "./memory-storage.ts";

test("transcript filters show every category by default", () => {
  expect(readSessionTranscriptFilters(undefined)).toEqual(
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  );
  expect(DEFAULT_SESSION_TRANSCRIPT_FILTERS).toMatchObject({
    agentInstructions: true,
    assistantMessages: true,
    systemPrompt: true,
    thinking: true,
    toolDefinitions: true,
    userMessages: true,
  });
  expect(DEFAULT_SESSION_TRANSCRIPT_FILTERS.notices).toBe(true);
  expect(DEFAULT_SESSION_TRANSCRIPT_FILTERS.toolActivity).toBe(true);
});

test("transcript filters round trip through browser storage", () => {
  const storage = createMemoryStorage();
  const filters = {
    ...DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    systemPrompt: false,
    thinking: false,
    toolDefinitions: false,
  };

  writeSessionTranscriptFilters(storage, filters);

  expect(readSessionTranscriptFilters(storage)).toEqual(filters);
  expect(storage.getItem("q-mush.session-transcript-filters.v1")).toBe(
    JSON.stringify(filters),
  );
});

test.each([
  "not json",
  "null",
  "[]",
  JSON.stringify({ ...DEFAULT_SESSION_TRANSCRIPT_FILTERS, thinking: "yes" }),
  JSON.stringify({ assistantMessages: true }),
  JSON.stringify({
    ...DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    agentInstructions: undefined,
  }),
])("invalid stored transcript filters fall back safely: %s", (stored) => {
  const storage = createMemoryStorage();
  storage.setItem("q-mush.session-transcript-filters.v1", stored);

  expect(readSessionTranscriptFilters(storage)).toEqual(
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  );
});

test("storage access failures do not prevent transcript defaults or updates", () => {
  const storage: SessionTranscriptFilterStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("full");
    },
  };

  expect(readSessionTranscriptFilters(storage)).toEqual(
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  );
  expect(() => {
    writeSessionTranscriptFilters(storage, DEFAULT_SESSION_TRANSCRIPT_FILTERS);
  }).not.toThrow();
});
