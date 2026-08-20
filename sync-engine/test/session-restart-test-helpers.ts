import type { SessionIntegration } from "../../sync-engine/sessions.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

interface DrainableSessionSetup {
  readonly database: Parameters<typeof closeSessionTestDatabase>[0];
  readonly sessions: Pick<SessionIntegration, "drain" | "escalateDrain">;
}

export async function escalateAndCloseDrain(
  setup: DrainableSessionSetup,
  drain: Promise<void>,
): Promise<void> {
  setup.sessions.escalateDrain();
  await drain;
  closeSessionTestDatabase(setup.database);
}
