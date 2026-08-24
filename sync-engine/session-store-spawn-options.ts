import type { AppDatabase } from "../shared/database.ts";

export function sessionSpawnIdentity(
  userId: string,
  sessionId: string,
  generation: number,
) {
  return { generation, sessionId, userId };
}

export function sessionSpawnReservationOptions(
  database: AppDatabase,
  userId: string,
  sessionId: string,
  generation: number,
) {
  return {
    database,
    identity: sessionSpawnIdentity(userId, sessionId, generation),
  };
}
