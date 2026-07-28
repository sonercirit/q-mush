import { and, asc, eq } from "drizzle-orm";
import type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { attachmentFallbacks } from "../shared/database/schema.ts";
import type { IdGenerator } from "../shared/ids.ts";

export interface AttachmentFallbackStoreResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

export class AttachmentFallbackStore {
  readonly #resources: AttachmentFallbackStoreResources;

  constructor(database: AppDatabase, generateId: IdGenerator) {
    this.#resources = { database, generateId };
  }

  list(userId: string): readonly AttachmentFallbackSelection[] {
    try {
      return this.#resources.database
        .select({
          credentialId: attachmentFallbacks.providerCredentialId,
          modality: attachmentFallbacks.modality,
          model: attachmentFallbacks.model,
          prompt: attachmentFallbacks.prompt,
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
  }

  set(
    userId: string,
    selection: AttachmentFallbackSelection,
    now: number,
  ): void {
    this.#resources.database.transaction((transaction) => {
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
          id: this.#resources.generateId(now),
          modality: selection.modality,
          model: selection.model,
          prompt: selection.prompt,
          provider: selection.provider,
          providerCredentialId: selection.credentialId,
          userId,
        })
        .run();
    });
  }
}
