import { and, eq, not, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { providerCredentialWorkspaces } from "../shared/database/schema.ts";

export function activeCredentialWorkspaceCondition(
  userId: string,
  workspaceId: string,
  credentialId?: string,
): SQL | undefined {
  return and(
    credentialId === undefined
      ? undefined
      : eq(providerCredentialWorkspaces.providerCredentialId, credentialId),
    eq(providerCredentialWorkspaces.userId, userId),
    eq(providerCredentialWorkspaces.workspaceId, workspaceId),
    not(providerCredentialWorkspaces.isDeleted),
  );
}

export function credentialWorkspaceExists(
  database: Pick<AppDatabase, "select">,
  userId: string,
  workspaceId: string,
  credentialId: string,
): boolean {
  return (
    database
      .select({ id: providerCredentialWorkspaces.id })
      .from(providerCredentialWorkspaces)
      .where(
        activeCredentialWorkspaceCondition(userId, workspaceId, credentialId),
      )
      .get() !== undefined
  );
}
