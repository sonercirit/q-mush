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
