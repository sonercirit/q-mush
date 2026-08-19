import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentPendingInputs } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { PendingInputForPromotion } from "./session-pending-inputs.ts";
import { parseStoredImages } from "./stored-agent-images.ts";

function activeInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
) {
  return database
    .select()
    .from(agentPendingInputs)
    .where(
      and(
        eq(agentPendingInputs.sessionId, sessionId),
        eq(agentPendingInputs.isDeleted, false),
      ),
    )
    .orderBy(asc(agentPendingInputs.sequence))
    .all();
}

function promotionInput(
  pending: ReturnType<typeof activeInputs>[number],
): PendingInputForPromotion {
  return {
    content: pending.content,
    id: pending.id,
    images: parseStoredImages(
      pending.images,
      "Stored pending session images are invalid",
    ),
    sessionId: pending.sessionId,
  };
}

export function activeDurableSystemPendingInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly PendingInputForPromotion[] {
  return activeInputs(database, sessionId)
    .filter(({ createdById }) => createdById === SYSTEM_ID)
    .map(promotionInput);
}

export function activeNonSystemPendingInput(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): PendingInputForPromotion | undefined {
  const pending = activeInputs(database, sessionId).find(
    ({ createdById }) => createdById !== SYSTEM_ID,
  );
  return pending === undefined ? undefined : promotionInput(pending);
}
