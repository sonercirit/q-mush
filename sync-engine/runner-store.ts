import {
  and,
  asc,
  count,
  eq,
  inArray,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import {
  connectionIsAccessible,
  connectionWorkspaceIsAvailable,
  readConnectionScopes,
  removeConnectionScopes,
  replaceConnectionScopes,
  validateConnectionScopes,
  type ConnectionScopeConfiguration,
} from "../shared/connection-scopes.ts";
import { escapedLikePattern, lowerLike } from "../shared/database-search.ts";
import type { AppDatabase } from "../shared/database.ts";
import { runners, runnerWorkspaces } from "../shared/database/schema.ts";
import { defaultValues } from "../shared/default-store.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { validPageWindow } from "../shared/pagination.ts";
import {
  createPendingRunnerSummary,
  type RunnerStatus,
  type RunnerSummary,
} from "../shared/runner-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";

const RUNNER_ONLINE_WINDOW_MILLISECONDS = 45_000;

export interface RunnerPage {
  readonly items: readonly RunnerSummary[];
  readonly totalItems: number;
}

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
  | "isGlobal"
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

function onlineRunnerCondition(
  userId: string,
  now: number,
  search?: string,
): SQL | undefined {
  const online = and(
    activeRunnerCondition({ userId }),
    sql`${runners.machineFingerprint} IS NOT NULL`,
    sql`${runners.lastSeenAt} >= ${now - RUNNER_ONLINE_WINDOW_MILLISECONDS}`,
  );
  if (search === undefined) {
    return online;
  }
  const pattern = escapedLikePattern(search);
  return and(
    online,
    or(
      lowerLike(runners.id, pattern),
      lowerLike(runners.name, pattern),
      lowerLike(runners.platform, pattern),
      lowerLike(runners.architecture, pattern),
    ),
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
    isGlobal: runner.isGlobal,
    lastSeenAt,
    name: runner.name,
    platform: runner.platform,
    status,
    workspaceIds: [],
  };
}

function runnerSummarySelection() {
  return {
    architecture: runners.architecture,
    id: runners.id,
    isDefault: runners.isDefault,
    isGlobal: runners.isGlobal,
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

function orderedRunnerQuery(database: AppDatabase, condition: SQL | undefined) {
  return database
    .select(runnerSummarySelection())
    .from(runners)
    .where(condition)
    .orderBy(asc(runners.createdAt), asc(runners.id));
}

export class RunnerStore {
  readonly #context: RunnerStoreContext;
  readonly #scopeConfiguration: ConnectionScopeConfiguration;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#context = { database, generateId };
    this.#scopeConfiguration = {
      associationTable: runnerWorkspaces,
      generateId,
      ownerIdColumn: runnerWorkspaces.runnerId,
      ownerTable: runners,
    };
  }

  get #database(): AppDatabase {
    return this.#context.database;
  }

  workspaceScopesAreValid(
    userId: string,
    workspaceIds: readonly string[],
  ): boolean {
    try {
      validateConnectionScopes(this.#database, userId, workspaceIds);
      return true;
    } catch {
      return false;
    }
  }

  create(
    userId: string,
    token: string,
    now: number,
    workspaceIds: readonly string[] = [GLOBAL_WORKSPACE_ID],
  ): RunnerSummary {
    const scopes = validateConnectionScopes(
      this.#database,
      userId,
      workspaceIds,
    );
    return this.#database.transaction((transaction) => {
      const id = this.#context.generateId(now);
      transaction
        .insert(runners)
        .values({
          ...createdAuditFields(userId, now),
          id,
          isGlobal: scopes.includes(GLOBAL_WORKSPACE_ID),
          tokenHash: hashToken(token),
          userId,
        })
        .run();
      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        id,
        scopes,
        now,
      );

      return createPendingRunnerSummary(id, {
        isGlobal: scopes.includes(GLOBAL_WORKSPACE_ID),
        workspaceIds: scopes.filter((scope) => scope !== GLOBAL_WORKSPACE_ID),
      });
    });
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

  isAvailable(
    userId: string,
    runnerId: string,
    now: number,
    workspaceId?: string,
  ): boolean {
    if (
      workspaceId !== undefined &&
      !connectionWorkspaceIsAvailable(this.#database, userId, workspaceId)
    ) {
      return false;
    }
    const stored = this.#database
      .select({
        isGlobal: runners.isGlobal,
        lastSeenAt: runners.lastSeenAt,
        machineFingerprint: runners.machineFingerprint,
      })
      .from(runners)
      .where(activeRunnerCondition({ id: runnerId, userId }))
      .get();
    const lastSeenAt = stored?.lastSeenAt?.getTime();
    if (stored === undefined) {
      return false;
    }
    const scopeAvailable = connectionIsAccessible(
      {
        isGlobal: stored.isGlobal,
        workspaceIds: this.#workspaceIds(userId, runnerId),
      },
      workspaceId,
    );
    return (
      scopeAvailable &&
      stored.machineFingerprint !== null &&
      lastSeenAt !== undefined &&
      now - lastSeenAt <= RUNNER_ONLINE_WINDOW_MILLISECONDS
    );
  }

  setScopes(
    userId: string,
    runnerId: string,
    workspaceIds: readonly string[],
    now: number,
  ): boolean {
    const stored = this.#database
      .select({ id: runners.id })
      .from(runners)
      .where(activeRunnerCondition({ id: runnerId, userId }))
      .get();
    if (stored === undefined) {
      return false;
    }
    const scopes = validateConnectionScopes(
      this.#database,
      userId,
      workspaceIds,
    );
    return this.#database.transaction((transaction) => {
      transaction
        .update(runners)
        .set({
          isGlobal: scopes.includes(GLOBAL_WORKSPACE_ID),
          ...updatedAuditFields(userId, now),
        })
        .where(eq(runners.id, runnerId))
        .run();
      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        runnerId,
        scopes,
        now,
      );
      return true;
    });
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

  list(
    userId: string,
    now: number,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    if (
      workspaceId !== undefined &&
      !connectionWorkspaceIsAvailable(this.#database, userId, workspaceId)
    ) {
      return [];
    }
    const accessibleIds =
      workspaceId === undefined
        ? undefined
        : this.#accessibleIds(userId, workspaceId);
    const rows = orderedRunnerQuery(
      this.#database,
      accessibleIds === undefined
        ? activeRunnerCondition({ userId })
        : and(
            activeRunnerCondition({ userId }),
            inArray(runners.id, accessibleIds),
          ),
    ).all();
    return rows.map((runner) => {
      const summary = {
        ...summarizeRunner(runner, now),
        workspaceIds: this.#workspaceIds(userId, runner.id),
      };
      return workspaceId === undefined
        ? {
            architecture: summary.architecture,
            id: summary.id,
            isDefault: summary.isDefault,
            lastSeenAt: summary.lastSeenAt,
            name: summary.name,
            platform: summary.platform,
            status: summary.status,
          }
        : summary;
    });
  }

  listOnline(
    userId: string,
    now: number,
    offset: number,
    limit: number,
    search?: string,
    workspaceId?: string,
  ): RunnerPage {
    if (!validPageWindow(offset, limit)) {
      throw new Error("The runner page is invalid");
    }
    if (
      workspaceId !== undefined &&
      !connectionWorkspaceIsAvailable(this.#database, userId, workspaceId)
    ) {
      return { items: [], totalItems: 0 };
    }
    const accessibleIds =
      workspaceId === undefined
        ? undefined
        : this.#accessibleIds(userId, workspaceId);
    const baseCondition = onlineRunnerCondition(userId, now, search);
    const condition =
      accessibleIds === undefined
        ? baseCondition
        : and(baseCondition, inArray(runners.id, accessibleIds));
    const totalItems =
      this.#database
        .select({ value: count() })
        .from(runners)
        .where(condition)
        .get()?.value ?? 0;
    const items = orderedRunnerQuery(this.#database, condition)
      .limit(limit)
      .offset(offset)
      .all()
      .map((runner) => ({
        ...summarizeRunner(runner, now),
        workspaceIds: this.#workspaceIds(userId, runner.id),
      }));
    return { items, totalItems };
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

        const pendingScopes = transaction
          .select({ workspaceId: runnerWorkspaces.workspaceId })
          .from(runnerWorkspaces)
          .where(
            and(
              eq(runnerWorkspaces.userId, stored.userId),
              eq(runnerWorkspaces.runnerId, stored.id),
              not(runnerWorkspaces.isDeleted),
            ),
          )
          .all()
          .map(({ workspaceId }) => workspaceId);
        const pendingIsGlobal = transaction
          .select({ isGlobal: runners.isGlobal })
          .from(runners)
          .where(eq(runners.id, stored.id))
          .get()?.isGlobal;

        transaction
          .update(runnerWorkspaces)
          .set(softDeletedAuditFields(stored.userId, now))
          .where(
            and(
              eq(runnerWorkspaces.userId, stored.userId),
              eq(runnerWorkspaces.runnerId, stored.id),
              not(runnerWorkspaces.isDeleted),
            ),
          )
          .run();
        transaction
          .update(runners)
          .set({
            ...softDeletedAuditFields(stored.userId, now),
            isGlobal: false,
          })
          .where(eq(runners.id, stored.id))
          .run();
        runnerId = computerRunner.id;
        const transferredScopes =
          pendingIsGlobal === true ? [GLOBAL_WORKSPACE_ID] : pendingScopes;
        transaction
          .update(runners)
          .set({ isGlobal: pendingIsGlobal === true })
          .where(eq(runners.id, runnerId))
          .run();
        replaceConnectionScopes(
          transaction,
          this.#scopeConfiguration,
          stored.userId,
          runnerId,
          transferredScopes,
          now,
        );
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
    const exists =
      this.#database
        .select({ id: runners.id })
        .from(runners)
        .where(activeRunnerCondition({ id: runnerId, userId }))
        .get() !== undefined;
    if (!exists) {
      return false;
    }
    this.#database.transaction((transaction) => {
      removeConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        runnerId,
        now,
      );
      transaction
        .update(runners)
        .set({
          ...softDeletedAuditFields(userId, now),
          isDefault: false,
          isGlobal: false,
        })
        .where(activeRunnerCondition({ id: runnerId, userId }))
        .run();
    });
    return true;
  }

  #accessibleIds(userId: string, workspaceId: string): readonly string[] {
    const scopedIds = this.#database
      .select({ id: runnerWorkspaces.runnerId })
      .from(runnerWorkspaces)
      .where(
        and(
          eq(runnerWorkspaces.userId, userId),
          eq(runnerWorkspaces.workspaceId, workspaceId),
          not(runnerWorkspaces.isDeleted),
        ),
      )
      .all()
      .map(({ id }) => id);
    return this.#database
      .select({ id: runners.id })
      .from(runners)
      .where(
        and(
          activeRunnerCondition({ userId }),
          workspaceId === GLOBAL_WORKSPACE_ID
            ? eq(runners.isGlobal, true)
            : inArray(
                runners.id,
                this.#database
                  .select({ id: runners.id })
                  .from(runners)
                  .where(eq(runners.isGlobal, true))
                  .all()
                  .map(({ id }) => id)
                  .concat(scopedIds),
              ),
        ),
      )
      .all()
      .map(({ id }) => id);
  }

  #workspaceIds(userId: string, runnerId: string): readonly string[] {
    return readConnectionScopes(
      this.#database,
      this.#scopeConfiguration,
      userId,
      runnerId,
    );
  }

  #activeRunnerForToken(token: string) {
    return this.#database
      .select(runnerIdentitySelection())
      .from(runners)
      .where(activeRunnerCondition({ tokenHash: hashToken(token) }))
      .get();
  }
}
