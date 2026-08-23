import { and, asc, eq } from "drizzle-orm";
import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { attachmentFallbacks } from "../shared/database/schema.ts";
import type { IdGenerator } from "../shared/ids.ts";

interface AttachmentFallbackStoreResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

export interface AttachmentFallbackStore {
  list(userId: string): readonly AttachmentFallbackSelection[];
  set(
    userId: string,
    selection: AttachmentFallbackSelection,
    now: number,
  ): void;
}

export function createAttachmentFallbackStore(
  database: AppDatabase,
  generateId: IdGenerator,
): AttachmentFallbackStore {
  const resources: AttachmentFallbackStoreResources = { database, generateId };
  return {
    list(userId) {
      try {
        return resources.database
          .select({
            credentialId: attachmentFallbacks.providerCredentialId,
            modality: attachmentFallbacks.modality,
            model: attachmentFallbacks.model,
            openRouterProviderTag: attachmentFallbacks.openRouterProviderTag,
            provider: attachmentFallbacks.provider,
          })
          .from(attachmentFallbacks)
          .where(
            and(
              eq(attachmentFallbacks.userId, userId),
              eq(attachmentFallbacks.isDeleted, false),
            ),
          )
          .orderBy(asc(attachmentFallbacks.modality))
          .all();
      } catch (error) {
        if (error instanceof Error && error.message.includes("no such table")) {
          return [];
        }
        throw error;
      }
    },
    set(userId, selection, now) {
      resources.database.transaction((transaction) => {
        transaction
          .update(attachmentFallbacks)
          .set({ ...updatedAuditFields(userId, now), isDeleted: true })
          .where(
            and(
              eq(attachmentFallbacks.userId, userId),
              eq(attachmentFallbacks.modality, selection.modality),
              eq(attachmentFallbacks.isDeleted, false),
            ),
          )
          .run();
        transaction
          .insert(attachmentFallbacks)
          .values({
            ...createdAuditFields(userId, now),
            id: resources.generateId(now),
            modality: selection.modality,
            model: selection.model,
            openRouterProviderTag: selection.openRouterProviderTag,
            provider: selection.provider,
            providerCredentialId: selection.credentialId,
            userId,
          })
          .run();
      });
    },
  };
}
