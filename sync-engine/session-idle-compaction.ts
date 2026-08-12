import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

const IDLE_COMPACTION_DELAY_MS = 30 * 60_000;

interface IdleCompactionCandidate {
  readonly id: string;
  readonly userId: string;
}

// A session qualifies once it has rested in a terminal-resumable status for
// the full delay with idle compaction enabled and uncompacted context. Any
// activity bumps updatedAt, so the cutoff also acts as the activity reset,
// and compaction zeroes currentContextTokens, so a compacted session cannot
// loop back into another idle compaction until it runs again.
function idleCompactionCandidates(
  database: Pick<AppDatabase, "select">,
  now: number,
): readonly IdleCompactionCandidate[] {
  const cutoff = new Date(now - IDLE_COMPACTION_DELAY_MS);
  const selection = { id: agentSessions.id, userId: agentSessions.userId };
  return database
    .select(selection)
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.isDeleted, false),
        eq(agentSessions.idleCompact, true),
        eq(agentSessions.runnerRequired, false),
        isNull(agentSessions.restartHandoff),
        inArray(agentSessions.status, ["completed", "idle"]),
        gt(agentSessions.currentContextTokens, 0),
        lte(agentSessions.updatedAt, cutoff),
      ),
    )
    .all();
}

interface IdleCompactionSchedulerOptions {
  readonly compact: (userId: string, sessionId: string) => Promise<Response>;
  readonly database: Pick<AppDatabase, "select">;
  readonly now: () => number;
}

// Runs on the liveness scan cadence: compacts every due session, letting
// per-session failures fall through to the next scan without aborting the
// batch. startManualSessionCompactionForUserId re-checks status, draining,
// runner requirements, and credentials at execution time. The scan never
// rejects — its caller fires and forgets from the liveness interval, so a
// candidate-query failure must not become a fatal unhandled rejection.
export async function compactIdleSessions(
  options: IdleCompactionSchedulerOptions,
): Promise<void> {
  let candidates: readonly IdleCompactionCandidate[];
  try {
    candidates = idleCompactionCandidates(options.database, options.now());
  } catch {
    return;
  }
  for (const candidate of candidates) {
    try {
      await options.compact(candidate.userId, candidate.id);
    } catch {
      // The next scan retries; compaction never interrupts the scan loop.
    }
  }
}
