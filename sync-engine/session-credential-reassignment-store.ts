import { and, eq, ne } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
} from "../shared/database/schema.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { SessionCredentialReassignmentResult } from "../shared/session-credential-reassignment.ts";

export class SessionCredentialReassignmentStore {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  reassign(
    userId: string,
    provider: ProviderId,
    credentialId: string,
    now: number,
  ): SessionCredentialReassignmentResult | undefined {
    return this.#database.transaction((transaction) => {
      const target = transaction.query.providerCredentials
        .findFirst({
          columns: { id: true },
          where: and(
            eq(providerCredentials.id, credentialId),
            eq(providerCredentials.userId, userId),
            eq(providerCredentials.provider, provider),
            eq(providerCredentials.isDeleted, false),
          ),
        })
        .sync();

      if (target === undefined) {
        return undefined;
      }

      const migrated = transaction
        .update(agentSessions)
        .set({
          providerCredentialId: credentialId,
          ...updatedAuditFields(userId, now),
        })
        .where(
          and(
            eq(agentSessions.userId, userId),
            eq(agentSessions.provider, provider),
            eq(agentSessions.isDeleted, false),
            ne(agentSessions.providerCredentialId, credentialId),
          ),
        )
        .returning({ migratedId: agentSessions.id })
        .all();

      return { migratedSessionCount: migrated.length };
    });
  }
}
