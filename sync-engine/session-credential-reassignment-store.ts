import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import { readOpenRouterProviderRouting } from "../shared/agent-configuration.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
} from "../shared/database/schema.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { SessionCredentialReassignmentResult } from "../shared/session-credential-reassignment.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { credentialWorkspaceExists } from "./credential-workspace-query.ts";
import { sqliteChangeCount } from "./database-changes.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import { ownedWorkspaceExists } from "./workspace-query.ts";

interface SessionCredentialReassignmentScope {
  readonly condition?: SQL;
  readonly workspaceId?: string;
}

interface SessionCredentialReassignmentSession {
  readonly credentialId: string;
  readonly id: string;
  readonly model: string;
  readonly openRouterProviderTag: string | null;
}

export interface SessionCredentialReassignmentSnapshot {
  readonly sessions: readonly SessionCredentialReassignmentSession[];
}

export interface SessionCredentialMetadataUpdate {
  readonly id: string;
  readonly maxContextTokens: number | null;
  readonly providerPricing: ProviderModelPricing | null;
}

export interface PreparedSessionCredentialProviderState {
  readonly expectedSessions: readonly SessionCredentialReassignmentSession[];
  readonly metadataUpdates: readonly SessionCredentialMetadataUpdate[];
}

export interface SessionCredentialReassignmentOptions {
  readonly credentialId: string;
  readonly now: number;
  readonly preparedProviderState?: PreparedSessionCredentialProviderState;
  readonly provider: ProviderId;
  readonly scope?: SessionCredentialReassignmentScope;
  readonly userId: string;
}

type SessionReassignmentSelection = Pick<
  SessionCredentialReassignmentOptions,
  "credentialId" | "provider" | "scope" | "userId"
>;

function sessionsToReassign(
  database: Pick<AppDatabase, "select">,
  selection: SessionReassignmentSelection,
): readonly SessionCredentialReassignmentSession[] {
  return database
    .select({
      credentialId: agentSessions.providerCredentialId,
      id: agentSessions.id,
      model: agentSessions.model,
      openRouterProviderTag: agentSessions.openRouterProviderTag,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, selection.userId),
        eq(agentSessions.provider, selection.provider),
        eq(agentSessions.isDeleted, false),
        ne(agentSessions.providerCredentialId, selection.credentialId),
        scopeCondition(selection.scope),
      ),
    )
    .orderBy(asc(agentSessions.id))
    .all();
}

function snapshotsMatch(
  actual: readonly SessionCredentialReassignmentSession[],
  expected: readonly SessionCredentialReassignmentSession[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((session, index) => {
      const candidate = expected[index];
      return (
        session.credentialId === candidate?.credentialId &&
        session.id === candidate.id &&
        session.model === candidate.model &&
        session.openRouterProviderTag === candidate.openRouterProviderTag
      );
    })
  );
}

function metadataUpdatesAreComplete(
  sessions: readonly SessionCredentialReassignmentSession[],
  updates: readonly SessionCredentialMetadataUpdate[],
): boolean {
  const taggedIds = new Set(
    sessions
      .filter(
        ({ openRouterProviderTag }) =>
          readOpenRouterProviderRouting(openRouterProviderTag)?.type ===
          "provider",
      )
      .map(({ id }) => id),
  );
  return (
    taggedIds.size === updates.length &&
    updates.every(({ id }) => taggedIds.delete(id)) &&
    taggedIds.size === 0
  );
}

function applyMetadataUpdates(
  transaction: Pick<AppDatabase, "select" | "update">,
  updates: readonly SessionCredentialMetadataUpdate[],
): void {
  for (const update of updates) {
    const current = transaction
      .select({ cap: agentSessions.userContextTokenCap })
      .from(agentSessions)
      .where(eq(agentSessions.id, update.id))
      .get();
    transaction
      .update(agentSessions)
      .set({
        maxContextTokens:
          current?.cap === null || current?.cap === undefined
            ? update.maxContextTokens
            : Math.min(current.cap, update.maxContextTokens ?? current.cap),
        providerPricing: serializeProviderPricing(update.providerPricing),
      })
      .where(eq(agentSessions.id, update.id))
      .run();
  }
}

function scopeCondition(
  scope: SessionCredentialReassignmentScope | undefined,
): SQL | undefined {
  if (scope === undefined) {
    return undefined;
  }
  if (scope.condition !== undefined) {
    return scope.condition;
  }
  if (
    scope.workspaceId === undefined ||
    scope.workspaceId === GLOBAL_WORKSPACE_ID
  ) {
    return undefined;
  }
  return eq(agentSessions.workspaceId, scope.workspaceId);
}

function targetCredential(
  database: Pick<AppDatabase, "select">,
  selection: SessionReassignmentSelection,
): { readonly isGlobal: boolean } | undefined {
  return database
    .select({ isGlobal: providerCredentials.isGlobal })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, selection.credentialId),
        eq(providerCredentials.userId, selection.userId),
        eq(providerCredentials.provider, selection.provider),
        eq(providerCredentials.isDeleted, false),
      ),
    )
    .get();
}

function targetIsAccessible(
  transaction: Pick<AppDatabase, "select">,
  userId: string,
  credentialId: string,
  isGlobal: boolean,
  workspaceId: string | undefined,
): boolean {
  if (workspaceId === undefined) {
    return true;
  }
  if (workspaceId === GLOBAL_WORKSPACE_ID) {
    return isGlobal;
  }
  const workspaceExists = ownedWorkspaceExists(
    transaction,
    userId,
    workspaceId,
  );
  if (!workspaceExists || isGlobal) {
    return workspaceExists;
  }
  return credentialWorkspaceExists(
    transaction,
    userId,
    workspaceId,
    credentialId,
  );
}

export class SessionCredentialReassignmentStore {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  snapshot(
    selection: SessionReassignmentSelection,
  ): SessionCredentialReassignmentSnapshot | undefined {
    const target = targetCredential(this.#database, selection);
    if (
      target === undefined ||
      !targetIsAccessible(
        this.#database,
        selection.userId,
        selection.credentialId,
        target.isGlobal,
        selection.scope?.workspaceId,
      )
    ) {
      return undefined;
    }
    return { sessions: sessionsToReassign(this.#database, selection) };
  }

  reassign(
    options: SessionCredentialReassignmentOptions,
  ): SessionCredentialReassignmentResult | undefined {
    return this.#database.transaction(
      (transaction) => {
        const target = targetCredential(transaction, options);

        if (target === undefined) {
          return undefined;
        }

        const workspaceId = options.scope?.workspaceId;
        if (
          !targetIsAccessible(
            transaction,
            options.userId,
            options.credentialId,
            target.isGlobal,
            workspaceId,
          )
        ) {
          return undefined;
        }

        const prepared = options.preparedProviderState;
        const currentSessions =
          prepared === undefined
            ? undefined
            : sessionsToReassign(transaction, options);
        if (
          prepared !== undefined &&
          (currentSessions === undefined ||
            !snapshotsMatch(currentSessions, prepared.expectedSessions) ||
            !metadataUpdatesAreComplete(
              currentSessions,
              prepared.metadataUpdates,
            ))
        ) {
          return undefined;
        }

        if (prepared !== undefined) {
          applyMetadataUpdates(transaction, prepared.metadataUpdates);
        }

        transaction
          .update(agentSessions)
          .set({
            providerCredentialId: options.credentialId,
            ...updatedAuditFields(options.userId, options.now),
          })
          .where(
            and(
              eq(agentSessions.userId, options.userId),
              eq(agentSessions.provider, options.provider),
              eq(agentSessions.isDeleted, false),
              ne(agentSessions.providerCredentialId, options.credentialId),
              scopeCondition(options.scope),
            ),
          )
          .run();
        const migratedSessionCount = sqliteChangeCount(
          this.#database,
          "SQLite did not return the reassignment count",
        );
        return { migratedSessionCount };
      },
      { behavior: "immediate" },
    );
  }
}
