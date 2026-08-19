import { withoutControlCharacters } from "../shared/string-validation.ts";

const TERMINAL_EVENT_MAXIMUM_LENGTH = 2_000;
const SENSITIVE_NAME = String.raw`(?:[A-Za-z][A-Za-z0-9]*(?:[_ -][A-Za-z0-9]+)*[_ -])?(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|credential(?:s)?|client[_ -]?secret|private[_ -]?key|pass(?:word|wd)|secret|token)(?:[_ -][A-Za-z0-9]+)*`;
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`["']?\b(${SENSITIVE_NAME})\b["']?\s*[:=]\s*(?:bearer\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)`,
  "giu",
);
const PROVIDER_SECRET =
  /\b(?:bearer\s+|github_pat_|ghp_|qmr_|sk-|sess-|xox[baprs]-)[-_A-Za-z0-9./+=]{8,}\b/giu;

export function sanitizedTerminalEventText(value: string): string {
  return withoutControlCharacters(value.slice(0, TERMINAL_EVENT_MAXIMUM_LENGTH))
    .replace(SENSITIVE_ASSIGNMENT, "$1=[redacted]")
    .replace(PROVIDER_SECRET, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}
