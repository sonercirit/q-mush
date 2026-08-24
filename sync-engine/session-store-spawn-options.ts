import type { AppDatabase } from "../shared/database.ts";

export function sessionSpawnIdentity(
  userId: string,
  sessionId: string,
  generation: number,
) {
  return { generation, sessionId, userId };
}

export function generatedSessionId(generateId: (now: number) => string) {
  return (now: number) => generateId(now);
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
