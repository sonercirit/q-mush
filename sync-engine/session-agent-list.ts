import { normalizeSearchText } from "../shared/search.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { utf8ByteLength, utf8Prefix } from "../shared/utf8.ts";
import { boundedPaginatedOutput } from "./session-agent-pagination.ts";

export const DEFAULT_LIST_SESSIONS_PAGE_SIZE = 20;
export const MAXIMUM_LIST_SESSIONS_PAGE_SIZE = 26;
export const MAXIMUM_LIST_SESSIONS_SEARCH_LENGTH = 100;
const MAXIMUM_LIST_SESSIONS_OUTPUT_BYTES = 48_000;
const MAXIMUM_LIST_SESSION_TEXT_BYTES = 80;

export interface ListSessionsToolInput {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
}

interface ListSessionItem {
  readonly id: string;
  readonly model: string;
  readonly parentSessionId: string | null;
  readonly provider: AgentSessionSummary["provider"];
  readonly runnerRequired: boolean;
  readonly status: AgentSessionSummary["status"];
  readonly title: string;
  readonly toolCount: number;
  readonly updatedAt: number;
  readonly workingDirectory: string;
}

interface BoundedListSessionItem {
  readonly item: ListSessionItem;
  readonly truncated: boolean;
}

function boundedText(value: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const text = utf8Prefix(value, MAXIMUM_LIST_SESSION_TEXT_BYTES);
  return { text, truncated: utf8ByteLength(text) < utf8ByteLength(value) };
}

function listSessionItem(session: AgentSessionSummary): BoundedListSessionItem {
  const model = boundedText(session.model);
  const title = boundedText(session.title);
  const workingDirectory = boundedText(session.workingDirectory);
  return {
    item: {
      id: session.id,
      model: model.text,
      parentSessionId: session.parentSessionId,
      provider: session.provider,
      runnerRequired: session.runnerRequired,
      status: session.status,
      title: title.text,
      toolCount: session.tools.length,
      updatedAt: session.updatedAt,
      workingDirectory: workingDirectory.text,
    },
    truncated: model.truncated || title.truncated || workingDirectory.truncated,
  };
}

function matchesSearch(session: AgentSessionSummary, query: string): boolean {
  return normalizeSearchText(
    [
      session.title,
      session.status,
      session.model,
      session.provider,
      session.workingDirectory,
    ].join(" "),
  ).includes(query);
}

export function listSessionsOutput(
  input: ListSessionsToolInput,
  sessions: readonly AgentSessionSummary[],
): string {
  const query =
    input.search === undefined ? undefined : normalizeSearchText(input.search);
  const matching =
    query === undefined
      ? sessions
      : sessions.filter((session) => matchesSearch(session, query));
  const start = (input.page - 1) * input.pageSize;
  const selected = matching
    .slice(start, start + input.pageSize)
    .map(listSessionItem);
  const totalItems = matching.length;
  let sourceFields = false;
  const items = selected.map(({ item, truncated }) => {
    sourceFields ||= truncated;
    return item;
  });
  return boundedPaginatedOutput({
    filters: input.search === undefined ? {} : { search: input.search },
    items,
    maximumBytes: MAXIMUM_LIST_SESSIONS_OUTPUT_BYTES,
    page: input.page,
    pageSize: input.pageSize,
    sourceFields,
    tooLargeMessage: "The bounded session list output is too large",
    totalItems,
  });
}
