import type { SessionViewState } from "./session-client.tsx";
import {
  readSessionTranscriptFilters,
  writeSessionTranscriptFilters,
  type SessionTranscriptFilterName,
  type SessionTranscriptFilters,
  type SessionTranscriptFilterStorage,
} from "./session-transcript-filters.ts";

export function browserTranscriptFilterStorage():
  SessionTranscriptFilterStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function updatedTranscriptFilters(
  filters: SessionTranscriptFilters,
  name: SessionTranscriptFilterName,
  visible: boolean,
  storage: SessionTranscriptFilterStorage | undefined,
): SessionTranscriptFilters {
  const updated = { ...filters, [name]: visible };
  writeSessionTranscriptFilters(storage, updated);
  return updated;
}

export function initialTranscriptFilters(
  state: SessionViewState,
  storage: SessionTranscriptFilterStorage | null | undefined,
): SessionViewState["transcriptFilters"] {
  return storage === null || storage === undefined
    ? state.transcriptFilters
    : readSessionTranscriptFilters(storage);
}
