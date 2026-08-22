import { normalizeSearchText } from "../shared/search.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { boundedPaginatedOutput } from "./session-agent-pagination.ts";

export const DEFAULT_LIST_SESSIONS_PAGE_SIZE = 20;
export const MAXIMUM_LIST_SESSIONS_PAGE_SIZE = 26;
export const MAXIMUM_LIST_SESSIONS_SEARCH_LENGTH = 100;

export interface ListSessionsToolInput {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
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
  const items = matching
    .slice(start, start + input.pageSize)
    .map((session) => ({
      id: session.id,
      model: session.model,
      parentSessionId: session.parentSessionId,
      provider: session.provider,
      runnerRequired: session.runnerRequired,
      status: session.status,
      title: session.title,
      toolCount: session.tools.length,
      updatedAt: session.updatedAt,
      workingDirectory: session.workingDirectory,
    }));
  return boundedPaginatedOutput({
    filters: input.search === undefined ? {} : { search: input.search },
    items,
    page: input.page,
    pageSize: input.pageSize,
    sourceFields: false,
    totalItems: matching.length,
  });
}
