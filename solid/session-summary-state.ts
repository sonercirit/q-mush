import type { AgentSessionSummary } from "../shared/session-model.ts";
import { listsMatchByIdentity, retainById } from "./collection-state.ts";

type SummaryMatches = (
  left: AgentSessionSummary,
  right: AgentSessionSummary,
) => boolean;

interface SessionSummaryCollection {
  readonly current: readonly AgentSessionSummary[] | undefined;
  readonly incoming: readonly AgentSessionSummary[];
  readonly matches: SummaryMatches;
}

function retainedSessionSummaries(
  collection: SessionSummaryCollection,
): readonly AgentSessionSummary[] {
  return retainById(
    collection.current,
    collection.incoming,
    collection.matches,
  );
}

export function mergeSessionSummaries(
  collection: SessionSummaryCollection,
): readonly AgentSessionSummary[] {
  return retainedSessionSummaries(collection);
}

export function sessionSummaryListsMatch(
  collection: SessionSummaryCollection,
): boolean {
  if (collection.current?.length !== collection.incoming.length) {
    return false;
  }
  const retained = retainedSessionSummaries(collection);
  return listsMatchByIdentity(collection.current, retained);
}
