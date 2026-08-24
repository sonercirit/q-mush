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
import { createRunnerRegistrationStore } from "./runner-registration-store.ts";
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

export interface RunnerStore {
  readonly database: AppDatabase;
  readonly registration: RunnerRegistrationOperations;
  readonly workspaceScopesAreValid: (
    userId: string,
    workspaceIds: readonly string[],
  ) => boolean;
  readonly create: (
    userId: string,
    token: string,
    now: number,
    workspaceIds?: readonly string[],
  ) => RunnerSummary;
  readonly hasActiveToken: (token: string) => boolean;
  readonly exists: (userId: string, runnerId: string) => boolean;
  readonly authenticate: (token: string) => RunnerConnection | undefined;
  readonly available: (parameters: RunnerAvailabilityParameters) => boolean;
  readonly isAvailable: (
    userId: string,
    runnerId: string,
    now: number,
    workspaceId?: string,
  ) => boolean;
  readonly setScopes: (
    userId: string,
    runnerId: string,
    workspaceIds: readonly string[],
    now: number,
  ) => boolean;
  readonly setDefault: (
    userId: string,
    runnerId: string,
    now: number,
  ) => boolean;
  readonly setOnline: (
    id: string,
    userId: string,
    now: number,
    online: boolean,
  ) => void;
  readonly list: (
    userId: string,
    now: number,
    workspaceId?: string,
  ) => readonly RunnerSummary[];
  readonly listOnline: (
    userId: string,
    now: number,
    offset: number,
    limit: number,
    search?: string,
    workspaceId?: string,
  ) => RunnerPage;
  readonly remove: (userId: string, runnerId: string, now: number) => boolean;
}

export function createRunnerStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
  generateActivationId: () => string = createUuidV7,
  reportParent?: RunnerStoreContext["reportParent"],
): RunnerStore {
  const context: RunnerStoreContext = {
    database,
    generateId,
    ...(reportParent === undefined ? {} : { reportParent }),
  };
  const scopeConfiguration: ConnectionScopeConfiguration = {
    associationTable: runnerWorkspaces,
    generateId,
    ownerIdColumn: runnerWorkspaces.runnerId,
    ownerTable: runners,
  };
  const registration = createRunnerRegistrationStore(
    database,
    {
      activeRunnerCondition,
      activeTokenCondition,
      runnerRegistrationSelection,
      tokenHashMatches,
    },
    generateActivationId,
  );

  function backfillLegacyToken(token: string, digest: string): boolean {
    const legacy = runnerQuery(
      database,
      { id: runners.id, tokenHash: runners.tokenHash },
      and(eq(runners.isDeleted, false), eq(runners.tokenDigest, "")),
    )
      .all()
      .find(({ tokenHash }) => tokenHashMatches(tokenHash, token));
    if (legacy === undefined) {
      return false;
    }
    try {
      database
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

  function workspaceScopesAreValid(
    userId: string,
    workspaceIds: readonly string[],
  ): boolean {
    try {
      validateConnectionScopes(database, userId, workspaceIds);
      return true;
    } catch {
      return false;
    }
  }

  function create(
    userId: string,
    token: string,
    now: number,
    workspaceIds: readonly string[] = [GLOBAL_WORKSPACE_ID],
  ): RunnerSummary {
    const scopes = validateConnectionScopes(database, userId, workspaceIds);
    const isGlobal = scopes.includes(GLOBAL_WORKSPACE_ID);
    const id = context.generateId(now);
    const tokenDigest = createTokenDigest(token);
    if (
      backfillLegacyToken(token, tokenDigest) ||
      activeRunnerForToken(token) !== undefined
    ) {
      throw new Error("The runner token is already active");
    }
    const tokenHash = createStoredTokenHash(token);
    database.transaction((transaction) => {
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
        scopeConfiguration,
        userId,
        id,
        scopes,
        now,
      );
    });
    const inserted = activeRunnerExists({ id });
    if (!inserted) {
      throw new Error("The runner token is already active");
    }

    return createPendingRunnerSummary(id, {
      isGlobal,
      workspaceIds: scopes.filter((scope) => scope !== GLOBAL_WORKSPACE_ID),
    });
  }

  function activeRunnerExists(filter: ActiveRunnerFilter): boolean {
    return (
      database
        .select({ id: runners.id })
        .from(runners)
        .where(activeRunnerCondition(filter))
        .get() !== undefined
    );
  }

  function hasActiveToken(token: string): boolean {
    return activeRunnerForToken(token) !== undefined;
  }

  function exists(userId: string, runnerId: string): boolean {
    return activeRunnerExists({ id: runnerId, userId });
  }

  function authenticate(token: string): RunnerConnection | undefined {
    const stored = activeRunnerForToken(token);

    return stored?.machineFingerprint == null
      ? undefined
      : { id: stored.id, userId: stored.userId };
  }

  function workspaceAvailable(userId: string, workspaceId?: string): boolean {
    return (
      workspaceId === undefined ||
      connectionWorkspaceIsAvailable(database, userId, workspaceId)
    );
  }

  function available(parameters: RunnerAvailabilityParameters): boolean {
    const [userId, runnerId, now, workspaceId] = parameters;
    if (!workspaceAvailable(userId, workspaceId)) {
      return false;
    }
    const stored = database
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
          workspaceIds: workspaceIds(userId, runnerId),
        },
        workspaceId,
      ) &&
      stored.machineFingerprint !== null &&
      lastSeenAt !== undefined &&
      now - lastSeenAt <= RUNNER_ONLINE_WINDOW_MILLISECONDS
    );
  }

  function isAvailable(
    userId: string,
    runnerId: string,
    now: number,
    workspaceId?: string,
  ): boolean {
    return available([userId, runnerId, now, workspaceId]);
  }

  function setScopes(
    userId: string,
    runnerId: string,
    workspaceIds: readonly string[],
    now: number,
  ): boolean {
    if (!exists(userId, runnerId)) {
      return false;
    }
    const scopes = validateConnectionScopes(database, userId, workspaceIds);
    database.transaction((transaction) => {
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
        scopeConfiguration,
        userId,
        runnerId,
        scopes,
        now,
      );
    });
    return true;
  }

  function setDefault(userId: string, runnerId: string, now: number): boolean {
    return database.transaction((transaction) => {
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

  function setOnline(
    id: string,
    userId: string,
    now: number,
    online: boolean,
  ): void {
    const lastSeenAt = online ? now : 0;
    database
      .update(runners)
      .set({
        lastSeenAt: new Date(lastSeenAt),
        ...updatedAuditFields(userId, now),
      })
      .where(activeRunnerCondition({ id, userId }))
      .run();
  }

  function summaries(
    userId: string,
    now: number,
    query: Pick<ReturnType<typeof orderedRunnerQuery>, "all">,
  ): readonly RunnerSummary[] {
    return query.all().map((runner) => ({
      ...summarizeRunner(runner, now),
      workspaceIds: workspaceIds(userId, runner.id),
    }));
  }

  function withWorkspaceRunnerIds<Result>(
    userId: string,
    workspaceId: string | undefined,
    unavailable: Result,
    available: (runnerIds: readonly string[] | undefined) => Result,
  ): Result {
    if (!workspaceAvailable(userId, workspaceId)) {
      return unavailable;
    }
    return available(
      accessibleRunnerIds(workspaceId, (selected) =>
        accessibleIds(userId, selected),
      ),
    );
  }

  function list(
    userId: string,
    now: number,
    workspaceId?: string,
  ): readonly RunnerSummary[] {
    return withWorkspaceRunnerIds(userId, workspaceId, [], (accessibleIds) =>
      summaries(
        userId,
        now,
        orderedRunnerQuery(
          database,
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

  function listOnline(
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

    return withWorkspaceRunnerIds(
      userId,
      workspaceId,
      { items: [], totalItems: 0 },
      (accessibleIds) => {
        const base = onlineRunnerCondition(userId, now, search);
        const condition =
          accessibleIds === undefined
            ? base
            : and(base, inArray(runners.id, accessibleIds));
        const totalItems = countSelectedRows(database, runners, condition);
        const items = summaries(
          userId,
          now,
          orderedRunnerQuery(database, condition).limit(limit).offset(offset),
        );

        return { items, totalItems };
      },
    );
  }

  function remove(userId: string, runnerId: string, now: number): boolean {
    const removed = database.transaction((transaction) => {
      removeConnectionScopes(
        transaction,
        scopeConfiguration,
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
        context.generateId,
        now,
      );
      return { reports };
    });
    if (removed === false) return false;
    for (const { report, userId: ownerId } of removed.reports) {
      emitReportedParent(context, ownerId, report);
    }
    return true;
  }

  function accessibleIds(
    userId: string,
    workspaceId: string,
  ): readonly string[] {
    return accessibleConnectionIds(
      database,
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

  function workspaceIds(userId: string, runnerId: string): readonly string[] {
    const resources = [database, scopeConfiguration, userId, runnerId] as const;
    return readConnectionScopes(...resources);
  }

  function activeRunnerForToken(token: string) {
    const matching = runnerQuery(
      database,
      runnerTokenSelection(),
      activeTokenCondition(token),
    ).all();
    return matching.length === 1 &&
      matching[0] !== undefined &&
      tokenHashMatches(matching[0].tokenHash, token)
      ? matching[0]
      : undefined;
  }

  return {
    authenticate,
    available,
    create,
    database,
    exists,
    hasActiveToken,
    isAvailable,
    list,
    listOnline,
    registration,
    remove,
    setDefault,
    setOnline,
    setScopes,
    workspaceScopesAreValid,
  };
}
