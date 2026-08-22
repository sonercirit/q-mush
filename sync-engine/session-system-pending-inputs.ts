import type { AppDatabase } from "../shared/database.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import {
  activeStoredPendingInputs,
  pendingInputForPromotion,
  type PendingInputForPromotion,
} from "./session-pending-inputs.ts";

export function activeDurableSystemPendingInputs(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly PendingInputForPromotion[] {
  return activeStoredPendingInputs(database, sessionId)
    .filter(({ createdById }) => createdById === SYSTEM_ID)
    .map(pendingInputForPromotion);
}

export function activeNonSystemPendingInput(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): PendingInputForPromotion | undefined {
  const pending = activeStoredPendingInputs(database, sessionId).find(
    ({ createdById }) => createdById !== SYSTEM_ID,
  );
  return pending === undefined ? undefined : pendingInputForPromotion(pending);
}
