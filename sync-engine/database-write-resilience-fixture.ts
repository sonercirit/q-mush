import { appendFileSync } from "node:fs";
import type { AppDatabase } from "../shared/database.ts";
import {
  createDatabaseWriteResilience,
  isDiskFullFailure,
} from "./database-write-resilience.ts";
import type { EngineHealth } from "./engine-health.ts";

const SHUTDOWN_TEST_RETRY_ENVIRONMENT =
  "Q_MUSH_TEST_DATABASE_BOUNDED_RETRY_STATE_PATH";
const SHUTDOWN_TEST_RETRY_ATTEMPTS = 4;
const SHUTDOWN_TEST_WRITE_STATEMENT =
  "UPDATE users SET updated_at = updated_at WHERE 0";

function fixtureDiskFullError(): Error & { readonly code: "SQLITE_FULL" } {
  return Object.assign(new Error("database or disk is full"), {
    code: "SQLITE_FULL" as const,
  });
}

export function recordDatabaseRetryFixtureEvent(
  environment: Readonly<Record<string, string | undefined>>,
  event: string,
): void {
  const statePath = environment[SHUTDOWN_TEST_RETRY_ENVIRONMENT];
  if (statePath !== undefined) {
    appendFileSync(statePath, `${event}\n`);
  }
}

export function startDatabaseRetryFixture(
  database: AppDatabase,
  health: EngineHealth,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (environment[SHUTDOWN_TEST_RETRY_ENVIRONMENT] === undefined) {
    return;
  }
  setTimeout(() => {
    let attempts = 0;
    const resilience = createDatabaseWriteResilience({
      attempt(operation) {
        attempts += 1;
        recordDatabaseRetryFixtureEvent(
          environment,
          `write-attempt:${String(attempts)}`,
        );
        if (attempts <= SHUTDOWN_TEST_RETRY_ATTEMPTS) {
          throw fixtureDiskFullError();
        }
        return operation();
      },
      health,
    });
    try {
      resilience.run("critical", () =>
        database.$client.prepare(SHUTDOWN_TEST_WRITE_STATEMENT).run(),
      );
      recordDatabaseRetryFixtureEvent(environment, "caller:unexpected-success");
    } catch (error) {
      recordDatabaseRetryFixtureEvent(
        environment,
        isDiskFullFailure(error)
          ? "caller:typed-disk-full-error"
          : `caller:unexpected-error:${String(error)}`,
      );
    }
  }, 0);
}
