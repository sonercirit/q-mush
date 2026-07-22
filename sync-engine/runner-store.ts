import { and, asc, eq, not, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { runners } from "../shared/database/schema.ts";
import { defaultValues } from "../shared/default-store.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import {
  createPendingRunnerSummary,
  type RunnerStatus,
  type RunnerSummary,
} from "../shared/runner-model.ts";

const RUNNER_ONLINE_WINDOW_MILLISECONDS = 45_000;

export interface RunnerConnection {
  readonly id: string;
  readonly userId: string;
}

export interface RunnerMetadata {
  readonly architecture: string;
  readonly machineFingerprint: string;
  readonly name: string;
  readonly platform: string;
}

export type RunnerRegistrationResult =
  | { readonly id: string; readonly status: "registered" }
  | { readonly status: "runner_exists" | "token_already_used" }
  | { readonly status: "unknown_token" };

type StoredRunnerSummary = Pick<
  typeof runners.$inferSelect,
  | "architecture"
  | "id"
  | "isDefault"
  | "lastSeenAt"
  | "machineFingerprint"
  | "name"
  | "platform"
>;

interface RunnerStoreContext {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

interface ActiveRunnerFilter {
  readonly id?: string;
  readonly tokenHash?: string;
  readonly userId?: string;
}

function activeRunnerCondition(
  filter: ActiveRunnerFilter = {},
): SQL | undefined {
  return and(
    eq(runners.isDeleted, false),
    filter.tokenHash === undefined
      ? undefined
      : eq(runners.tokenHash, filter.tokenHash),
    filter.userId === undefined ? undefined : eq(runners.userId, filter.userId),
    filter.id === undefined ? undefined : eq(runners.id, filter.id),
  );
}

function defaultRunnerCondition(userId: string): SQL | undefined {
  return and(
    eq(runners.userId, userId),
    not(runners.isDeleted),
    runners.isDefault,
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function summarizeRunner(
  runner: StoredRunnerSummary,
  now: number,
): RunnerSummary {
  const lastSeenAt = runner.lastSeenAt?.getTime() ?? null;
  let status: RunnerStatus;

  if (runner.machineFingerprint === null) {
    status = "pending";
  } else if (
    lastSeenAt !== null &&
    now - lastSeenAt <= RUNNER_ONLINE_WINDOW_MILLISECONDS
  ) {
    status = "online";
  } else {
    status = "offline";
  }

  return {
    architecture: runner.architecture,
    id: runner.id,
    isDefault: runner.isDefault,
    lastSeenAt,
    name: runner.name,
    platform: runner.platform,
    status,
  };
}

function runnerSummarySelection() {
  return {
    architecture: runners.architecture,
    id: runners.id,
    isDefault: runners.isDefault,
    lastSeenAt: runners.lastSeenAt,
    machineFingerprint: runners.machineFingerprint,
    name: runners.name,
    platform: runners.platform,
  };
}

function runnerIdentitySelection() {
  return {
    id: runners.id,
    machineFingerprint: runners.machineFingerprint,
    userId: runners.userId,
  };
}

export class RunnerStore {
  readonly #context: RunnerStoreContext;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#context = { database, generateId };
  }

  get #database(): AppDatabase {
    return this.#context.database;
  }

  create(userId: string, token: string, now: number): RunnerSummary {
    const id = this.#context.generateId(now);
    this.#database
      .insert(runners)
      .values({
        ...createdAuditFields(userId, now),
        id,
        tokenHash: hashToken(token),
        userId,
      })
      .run();

    return createPendingRunnerSummary(id);
  }

  hasActiveToken(token: string): boolean {
    return this.#activeRunnerForToken(token) !== undefined;
  }

  authenticate(token: string): RunnerConnection | undefined {
    const stored = this.#activeRunnerForToken(token);

    return stored?.machineFingerprint == null
      ? undefined
      : { id: stored.id, userId: stored.userId };
  }

  isAvailable(userId: string, runnerId: string, now: number): boolean {
    const stored = this.#database
      .select({
        lastSeenAt: runners.lastSeenAt,
        machineFingerprint: runners.machineFingerprint,
      })
      .from(runners)
      .where(activeRunnerCondition({ id: runnerId, userId }))
      .get();
    const lastSeenAt = stored?.lastSeenAt?.getTime();
    return (
      stored?.machineFingerprint !== null &&
      stored?.machineFingerprint !== undefined &&
      lastSeenAt !== undefined &&
      now - lastSeenAt <= RUNNER_ONLINE_WINDOW_MILLISECONDS
    );
  }

  setDefault(userId: string, runnerId: string, now: number): boolean {
    return this.#database.transaction((transaction) => {
      const runner = transaction.query.runners
        .findFirst({
          columns: { id: true },
          where: activeRunnerCondition({ id: runnerId, userId }),
        })
        .sync();

      if (runner === undefined) {
        return false;
      }

      transaction
        .update(runners)
        .set(defaultValues(userId, now, false))
        .where(defaultRunnerCondition(userId))
        .run();
      transaction
        .update(runners)
        .set(defaultValues(userId, now, true))
        .where(eq(runners.id, runnerId))
        .run();
      return true;
    });
  }

  setOnline(id: string, userId: string, now: number, online: boolean): void {
    const lastSeenAt = online ? now : 0;
    this.#database
      .update(runners)
      .set({
        ...updatedAuditFields(userId, now),
        lastSeenAt: new Date(lastSeenAt),
      })
      .where(activeRunnerCondition({ id, userId }))
      .run();
  }

  list(userId: string, now: number): readonly RunnerSummary[] {
    return this.#database
      .select(runnerSummarySelection())
      .from(runners)
      .where(activeRunnerCondition({ userId }))
      .orderBy(asc(runners.createdAt), asc(runners.id))
      .all()
      .map((runner) => summarizeRunner(runner, now));
  }

  register(
    token: string,
    metadata: RunnerMetadata,
    now: number,
  ): RunnerRegistrationResult {
    const tokenHash = hashToken(token);

    return this.#database.transaction((transaction) => {
      const stored = transaction
        .select(runnerIdentitySelection())
        .from(runners)
        .where(activeRunnerCondition({ tokenHash }))
        .get();

      if (stored === undefined) {
        return { status: "unknown_token" };
      }

      if (
        stored.machineFingerprint !== null &&
        stored.machineFingerprint !== metadata.machineFingerprint
      ) {
        return { status: "token_already_used" };
      }

      const computerRunner = transaction
        .select({ id: runners.id, userId: runners.userId })
        .from(runners)
        .where(
          and(
            eq(runners.isDeleted, false),
            eq(runners.machineFingerprint, metadata.machineFingerprint),
          ),
        )
        .get();

      let runnerId = stored.id;

      if (computerRunner !== undefined && computerRunner.id !== stored.id) {
        if (computerRunner.userId !== stored.userId) {
          return { status: "runner_exists" };
        }

        transaction
          .update(runners)
          .set(softDeletedAuditFields(stored.userId, now))
          .where(eq(runners.id, stored.id))
          .run();
        runnerId = computerRunner.id;
      }

      const timestamp = new Date(now);
      transaction
        .update(runners)
        .set({
          architecture: metadata.architecture,
          lastSeenAt: timestamp,
          machineFingerprint: metadata.machineFingerprint,
          name: metadata.name,
          platform: metadata.platform,
          tokenHash,
          ...updatedAuditFields(stored.userId, now),
        })
        .where(eq(runners.id, runnerId))
        .run();

      return { id: runnerId, status: "registered" };
    });
  }

  remove(userId: string, runnerId: string, now: number): boolean {
    const removed = this.#database
      .update(runners)
      .set({ ...softDeletedAuditFields(userId, now), isDefault: false })
      .where(activeRunnerCondition({ id: runnerId, userId }))
      .returning({ id: runners.id })
      .all();
    return removed.length > 0;
  }

  #activeRunnerForToken(token: string) {
    return this.#database
      .select(runnerIdentitySelection())
      .from(runners)
      .where(activeRunnerCondition({ tokenHash: hashToken(token) }))
      .get();
  }
}
