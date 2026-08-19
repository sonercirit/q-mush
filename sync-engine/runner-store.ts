import { and, eq, inArray, not, or, sql, type SQL } from "drizzle-orm";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import { accessibleConnectionIds } from "../shared/connection-access.ts";
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
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { validPageWindow } from "../shared/pagination.ts";
import {
  createPendingRunnerSummary,
  RUNNER_ONLINE_WINDOW_MILLISECONDS,
  type RunnerStatus,
  type RunnerSummary,
} from "../shared/runner-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { countSelectedRows } from "./database-count.ts";
import { exactlyOneUpdatedRow } from "./database-update.ts";
import { requireRunnerReassignment } from "./runner-reassignment-store.ts";
import type { RunnerRegistrationOperations } from "./runner-registration-operations.ts";
import {
  legacyRunnerTokenCondition,
  runnerQuery,
  runnerRegistrationSelection,
  runnerTokenSelection,
} from "./runner-registration-query.ts";
import { RunnerRegistrationStore } from "./runner-registration-store.ts";
import type { RunnerConnection } from "./runner-registration-types.ts";
import { orderedRunnerQuery } from "./runner-selection.ts";
import {
  createStoredTokenHash,
  createTokenDigest,
  tokenHashMatches,
} from "./runner-token.ts";
import type { RunnerAvailabilityParameters } from "./session-runner-availability.ts";
import {
  emitReportedParent,
  type ReportedParentEvent,
} from "./session-store-resources.ts";

export type {
  RunnerConnection,
  RunnerMetadata,
  RunnerRegistrationFence,
  RunnerRegistrationPrepareOptions,
} from "./runner-registration-types.ts";

export interface RunnerPage {
  readonly items: readonly RunnerSummary[];
  readonly totalItems: number;
}

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
  readonly reportParent?: (userId: string, report: ReportedParentEvent) => void;
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

function activeTokenCondition(token: string): SQL | undefined {
  const digest = createTokenDigest(token);
  return and(
    eq(runners.isDeleted, false),
    or(
      eq(runners.tokenDigest, digest),
      and(eq(runners.tokenDigest, ""), eq(runners.tokenHash, digest)),
    ),
  );
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

function accessibleRunnerIds(
  workspaceId: string | undefined,
  read: (workspaceId: string) => readonly string[],
): readonly string[] | undefined {
  return workspaceId === undefined ? undefined : read(workspaceId);
}

export class RunnerStore {
  readonly #context: RunnerStoreContext;
  readonly registration: RunnerRegistrationOperations;
  readonly #scopeConfiguration: ConnectionScopeConfiguration;

  constructor(
    database: AppDatabase,
    generateId: IdGenerator = createUuidV7,
    generateActivationId: () => string = createUuidV7,
    reportParent?: RunnerStoreContext["reportParent"],
  ) {
    this.#context = {
      database,
      generateId,
      ...(reportParent === undefined ? {} : { reportParent }),
    };
    this.#scopeConfiguration = {
      associationTable: runnerWorkspaces,
      generateId,
      ownerIdColumn: runnerWorkspaces.runnerId,
      ownerTable: runners,
    };
    this.registration = new RunnerRegistrationStore(
      database,
      {
        activeRunnerCondition,
        activeTokenCondition,
        runnerRegistrationSelection,
        tokenHashMatches,
      },
      generateActivationId,
    );
  }

  get database(): AppDatabase {
    return this.#context.database;
  }

  get #database(): AppDatabase {
    return this.database;
  }

  #backfillLegacyToken(token: string, digest: string): boolean {
    const legacy = runnerQuery(
      this.#database,
      { id: runners.id, tokenHash: runners.tokenHash },
      and(eq(runners.isDeleted, false), eq(runners.tokenDigest, "")),
    )
      .all()
      .find(({ tokenHash }) => tokenHashMatches(tokenHash, token));
    if (legacy === undefined) {
      return false;
    }
    try {
      this.#database
        .update(runners)
        .set({ tokenDigest: digest })
        .where(
          legacyRunnerTokenCondition(
            activeRunnerCondition,
            legacy.id,
            legacy.tokenHash,
          ),
        )
        .run();
    } catch {
      // Another active row already owns this plaintext token digest.
    }
    return true;
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
    const isGlobal = scopes.includes(GLOBAL_WORKSPACE_ID);
    const id = this.#context.generateId(now);
    const tokenDigest = createTokenDigest(token);
    if (
      this.#backfillLegacyToken(token, tokenDigest) ||
      this.#activeRunnerForToken(token) !== undefined
    ) {
      throw new Error("The runner token is already active");
    }
    const tokenHash = createStoredTokenHash(token);
    this.#database.transaction((transaction) => {
      transaction
        .insert(runners)
        .values({
          ...createdAuditFields(userId, now),
          id,
          isGlobal,
          tokenDigest,
          tokenHash,
          userId,
        })
        .onConflictDoNothing()
        .run();
      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        id,
        scopes,
        now,
      );
    });
    const inserted = this.#activeRunnerExists({ id });
    if (!inserted) {
      throw new Error("The runner token is already active");
    }

    return createPendingRunnerSummary(id, {
      isGlobal,
      workspaceIds: scopes.filter((scope) => scope !== GLOBAL_WORKSPACE_ID),
    });
  }

  #activeRunnerExists(filter: ActiveRunnerFilter): boolean {
    return (
      this.#database
        .select({ id: runners.id })
        .from(runners)
        .where(activeRunnerCondition(filter))
        .get() !== undefined
    );
  }

  hasActiveToken(token: string): boolean {
    return this.#activeRunnerForToken(token) !== undefined;
  }

  exists(userId: string, runnerId: string): boolean {
    return this.#activeRunnerExists({ id: runnerId, userId });
  }

  authenticate(token: string): RunnerConnection | undefined {
    const stored = this.#activeRunnerForToken(token);

    return stored?.machineFingerprint == null
      ? undefined
      : { id: stored.id, userId: stored.userId };
  }

  #workspaceAvailable(userId: string, workspaceId?: string): boolean {
    return (
      workspaceId === undefined ||
      connectionWorkspaceIsAvailable(this.#database, userId, workspaceId)
    );
  }

  available(parameters: RunnerAvailabilityParameters): boolean {
    const [userId, runnerId, now, workspaceId] = parameters;
    if (!this.#workspaceAvailable(userId, workspaceId)) {
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
    return (
      connectionIsAccessible(
        {
          isGlobal: stored.isGlobal,
          workspaceIds: this.#workspaceIds(userId, runnerId),
        },
        workspaceId,
      ) &&
      stored.machineFingerprint !== null &&
      lastSeenAt !== undefined &&
      now - lastSeenAt <= RUNNER_ONLINE_WINDOW_MILLISECONDS
    );
  }

  isAvailable(
    userId: string,
    runnerId: string,
    now: number,
    workspaceId?: string,
  ): boolean {
    return this.available([userId, runnerId, now, workspaceId]);
  }

  setScopes(
    userId: string,
    runnerId: string,
    workspaceIds: readonly string[],
    now: number,
  ): boolean {
    if (!this.exists(userId, runnerId)) {
      return false;
    }
    const scopes = validateConnectionScopes(
      this.#database,
      userId,
      workspaceIds,
    );
    this.#database.transaction((transaction) => {
      transaction
        .update(runners)
        .set({
          isGlobal: scopes.includes(GLOBAL_WORKSPACE_ID),
          ...updatedAuditFields(userId, now),
        })
        .where(activeRunnerCondition({ id: runnerId, userId }))
        .run();
      replaceConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        runnerId,
        scopes,
        now,
      );
    });
    return true;
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
        .set({ isDefault: false, ...updatedAuditFields(userId, now) })
        .where(defaultRunnerCondition(userId))
        .run();
      transaction
        .update(runners)
        .set({ isDefault: true, ...updatedAuditFields(userId, now) })
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
        lastSeenAt: new Date(lastSeenAt),
        ...updatedAuditFields(userId, now),
      })
      .where(activeRunnerCondition({ id, userId }))
      .run();
  }

  #summaries(
    userId: string,
    now: number,
    query: Pick<ReturnType<typeof orderedRunnerQuery>, "all">,
  ): readonly RunnerSummary[] {
    return query.all().map((runner) => ({
      ...summarizeRunner(runner, now),
      workspaceIds: this.#workspaceIds(userId, runner.id),
    }));
  }

  #withWorkspaceRunnerIds<Result>(
    userId: string,
    workspaceId: string | undefined,
    unavailable: Result,
    available: (runnerIds: readonly string[] | undefined) => Result,
  ): Result {
    if (!this.#workspaceAvailable(userId, workspaceId)) {
      return unavailable;
    }
    return available(
      accessibleRunnerIds(workspaceId, (selected) =>
        this.#accessibleIds(userId, selected),
      ),
    );
  }

  list(
    userId: string,
    now: number,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    return this.#withWorkspaceRunnerIds(
      userId,
      workspaceId,
      [],
      (accessibleIds) =>
        this.#summaries(
          userId,
          now,
          orderedRunnerQuery(
            this.#database,
            accessibleIds === undefined
              ? activeRunnerCondition({ userId })
              : and(
                  activeRunnerCondition({ userId }),
                  inArray(runners.id, accessibleIds),
                ),
          ),
        ),
    );
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

    return this.#withWorkspaceRunnerIds(
      userId,
      workspaceId,
      { items: [], totalItems: 0 },
      (accessibleIds) => {
        const base = onlineRunnerCondition(userId, now, search);
        const condition =
          accessibleIds === undefined
            ? base
            : and(base, inArray(runners.id, accessibleIds));
        const totalItems = countSelectedRows(
          this.#database,
          runners,
          condition,
        );
        const items = this.#summaries(
          userId,
          now,
          orderedRunnerQuery(this.#database, condition)
            .limit(limit)
            .offset(offset),
        );

        return { items, totalItems };
      },
    );
  }

  remove(userId: string, runnerId: string, now: number): boolean {
    const removed = this.#database.transaction((transaction) => {
      removeConnectionScopes(
        transaction,
        this.#scopeConfiguration,
        userId,
        runnerId,
        now,
      );
      const runnerRemoved = exactlyOneUpdatedRow(
        transaction,
        runners,
        {
          ...softDeletedAuditFields(userId, now),
          isDefault: false,
          isGlobal: false,
        },
        activeRunnerCondition({ id: runnerId, userId }),
        runners.id,
      );

      if (!runnerRemoved) {
        return false;
      }

      const reports = requireRunnerReassignment(
        transaction,
        userId,
        runnerId,
        this.#context.generateId,
        now,
      );
      return { reports };
    });
    if (removed === false) return false;
    for (const { report, userId: ownerId } of removed.reports) {
      emitReportedParent(this.#context, ownerId, report);
    }
    return true;
  }

  #accessibleIds(userId: string, workspaceId: string): readonly string[] {
    return accessibleConnectionIds(
      this.#database,
      {
        associationOwnerId: runnerWorkspaces.runnerId,
        associationTable: runnerWorkspaces,
        ownerGlobal: runners.isGlobal,
        ownerId: runners.id,
        ownerTable: runners,
      },
      userId,
      workspaceId,
      activeRunnerCondition({ userId }),
    );
  }

  #workspaceIds(userId: string, runnerId: string): readonly string[] {
    const resources = [
      this.#database,
      this.#scopeConfiguration,
      userId,
      runnerId,
    ] as const;
    return readConnectionScopes(...resources);
  }

  #activeRunnerForToken(token: string) {
    const matching = runnerQuery(
      this.#database,
      runnerTokenSelection(),
      activeTokenCondition(token),
    ).all();
    return matching.length === 1 &&
      matching[0] !== undefined &&
      tokenHashMatches(matching[0].tokenHash, token)
      ? matching[0]
      : undefined;
  }
}
