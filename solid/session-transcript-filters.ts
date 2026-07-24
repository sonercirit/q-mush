import { isRecord } from "../shared/auth-model.ts";

export interface SessionTranscriptFilters {
  readonly agentInstructions: boolean;
  readonly assistantMessages: boolean;
  readonly notices: boolean;
  readonly systemPrompt: boolean;
  readonly thinking: boolean;
  readonly toolActivity: boolean;
  readonly toolDefinitions: boolean;
  readonly userMessages: boolean;
}

export type SessionTranscriptFilterName = keyof SessionTranscriptFilters;

export interface SessionTranscriptFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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

const SESSION_TRANSCRIPT_FILTER_STORAGE_KEY =
  "q-mush.session-transcript-filters.v1";

export const DEFAULT_SESSION_TRANSCRIPT_FILTERS: SessionTranscriptFilters =
  transcriptFilterDefaults();

function transcriptFilterDefaults(): SessionTranscriptFilters {
  return {
    agentInstructions: true,
    assistantMessages: true,
    notices: true,
    systemPrompt: false,
    thinking: false,
    toolActivity: true,
    toolDefinitions: false,
    userMessages: true,
  };
}

function parsedFilters(value: unknown): SessionTranscriptFilters | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const agentInstructions = value["agentInstructions"];
  const assistantMessages = value["assistantMessages"];
  const notices = value["notices"];
  const systemPrompt = value["systemPrompt"];
  const thinking = value["thinking"];
  const toolActivity = value["toolActivity"];
  const toolDefinitions = value["toolDefinitions"];
  const userMessages = value["userMessages"];
  if (
    typeof agentInstructions !== "boolean" ||
    typeof assistantMessages !== "boolean" ||
    typeof notices !== "boolean" ||
    typeof systemPrompt !== "boolean" ||
    typeof thinking !== "boolean" ||
    typeof toolActivity !== "boolean" ||
    typeof toolDefinitions !== "boolean" ||
    typeof userMessages !== "boolean"
  ) {
    return undefined;
  }

  return {
    agentInstructions,
    assistantMessages,
    notices,
    systemPrompt,
    thinking,
    toolActivity,
    toolDefinitions,
    userMessages,
  };
}

function copyDefaults(): SessionTranscriptFilters {
  return { ...DEFAULT_SESSION_TRANSCRIPT_FILTERS };
}

export function readSessionTranscriptFilters(
  storage: SessionTranscriptFilterStorage | undefined,
): SessionTranscriptFilters {
  if (storage === undefined) {
    return copyDefaults();
  }

  try {
    const stored = storage.getItem(SESSION_TRANSCRIPT_FILTER_STORAGE_KEY);
    if (stored === null) {
      return copyDefaults();
    }
    const parsed: unknown = JSON.parse(stored);
    return parsedFilters(parsed) ?? copyDefaults();
  } catch {
    return copyDefaults();
  }
}

export function writeSessionTranscriptFilters(
  storage: SessionTranscriptFilterStorage | undefined,
  filters: SessionTranscriptFilters,
): void {
  try {
    storage?.setItem(
      SESSION_TRANSCRIPT_FILTER_STORAGE_KEY,
      JSON.stringify(filters),
    );
  } catch {
    // Browser privacy and quota settings must not block transcript controls.
  }
}
