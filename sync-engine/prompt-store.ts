import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { prompts, workspaces } from "../shared/database/schema.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import {
  PROMPT_MAXIMUM_COUNT,
  promptNameKey,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import {
  createOperationProducer,
  operationAccountIntent,
  operationEntityIntent,
} from "./operation-producer.ts";
import {
  PROMPT_STATE_SELECTION,
  promptStateCondition,
  storedPromptId,
} from "./prompt-query.ts";

export type PromptStoreErrorKind =
  "duplicate_prompt_name" | "prompt_changed" | "prompt_limit";

export type PromptStoreError = Error & { readonly kind: PromptStoreErrorKind };

const promptStoreErrorMessages: Record<PromptStoreErrorKind, string> = {
  duplicate_prompt_name: "An active prompt with that name already exists",
  prompt_changed: "The prompt changed after it was read",
  prompt_limit: "The active prompt limit has been reached",
};

function createPromptStoreError(kind: PromptStoreErrorKind): PromptStoreError {
  return Object.assign(new Error(promptStoreErrorMessages[kind]), {
    kind,
    name: "PromptStoreError",
  });
}

export function isPromptStoreErrorKind(
  error: unknown,
  kind: PromptStoreErrorKind,
): error is PromptStoreError {
  return error instanceof Error && "kind" in error && error.kind === kind;
}

function activePromptCondition(
  userId: string,
  promptId?: string,
): SQL | undefined {
  return and(
    eq(prompts.userId, userId),
    eq(prompts.isDeleted, false),
    promptId === undefined ? undefined : eq(prompts.id, promptId),
  );
}

function promptNameCondition(userId: string, normalizedName: string) {
  return and(
    activePromptCondition(userId),
    eq(prompts.normalizedName, normalizedName),
  );
}

function currentPromptCondition(
  userId: string,
  promptId: string,
  revision: number,
): SQL | undefined {
  return and(
    activePromptCondition(userId, promptId),
    eq(prompts.revision, revision),
  );
}

function changedOwnedPrompt(
  userId: string,
  promptId: string,
  revision: number,
) {
  return {
    condition: currentPromptCondition(userId, promptId, revision),
    revision: sql`${prompts.revision} + 1`,
  };
}

function promptSelection() {
  return {
    body: prompts.body,
    createdAt: prompts.createdAt,
    id: prompts.id,
    name: prompts.name,
    revision: prompts.revision,
    updatedAt: prompts.updatedAt,
  };
}

function promptColumns() {
  return {
    body: true,
    createdAt: true,
    id: true,
    name: true,
    revision: true,
    updatedAt: true,
  } as const;
}

type StoredPrompt =
  ReturnType<typeof promptSelection> extends infer Selection
    ? {
        readonly [Key in keyof Selection]: Key extends "createdAt" | "updatedAt"
          ? Date
          : Key extends "revision"
            ? number
            : string;
      }
    : never;

function presentPrompt(stored: StoredPrompt): Prompt {
  return {
    body: stored.body,
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    name: stored.name,
    revision: stored.revision,
    updatedAt: stored.updatedAt.getTime(),
  };
}

function rethrowPromptWriteError(error: unknown): never {
  const duplicate =
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: prompts.user_id");
  if (duplicate) {
    throw createPromptStoreError("duplicate_prompt_name");
  }
  throw error;
}

export interface PromptStore {
  readonly create: (userId: string, input: PromptInput, now: number) => Prompt;
  readonly get: (userId: string, promptId: string) => Prompt | undefined;
  readonly list: (userId: string) => readonly Prompt[];
  readonly remove: (
    userId: string,
    promptId: string,
    now: number,
    revision: number,
  ) => boolean;
  readonly update: (
    userId: string,
    promptId: string,
    input: PromptInput,
    now: number,
    revision: number,
  ) => Prompt | undefined;
}

export function createPromptStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
  maximumCount = PROMPT_MAXIMUM_COUNT,
): PromptStore {
  const producer = createOperationProducer({ database });
  const ensureAccount = (userId: string) => {
    const current = database
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)))
      .get();
    return operationAccountIntent(current ?? null);
  };
  const throwIfChanged = (
    userId: string,
    promptId: string,
    revision: number,
  ): void => {
    const stored = database
      .select(PROMPT_STATE_SELECTION)
      .from(prompts)
      .where(promptStateCondition(userId, promptId))
      .get();
    if (
      stored !== undefined &&
      (stored.isDeleted || stored.revision !== revision)
    ) {
      throw createPromptStoreError("prompt_changed");
    }
  };
  return {
    create: (userId, input, now) => {
      try {
        return database.transaction((transaction) => {
          const storedCount = transaction
            .select({ count: sql<number>`count(*)` })
            .from(prompts)
            .where(activePromptCondition(userId))
            .get();
          if ((storedCount?.count ?? 0) >= maximumCount) {
            throw createPromptStoreError("prompt_limit");
          }
          const normalizedName = promptNameKey(input.name);
          if (
            storedPromptId([
              transaction,
              promptNameCondition(userId, normalizedName),
            ]) !== undefined
          ) {
            throw createPromptStoreError("duplicate_prompt_name");
          }
          const timestamp = new Date(now);
          const inserted = transaction
            .insert(prompts)
            .values({
              body: input.body,
              createdAt: timestamp,
              createdById: userId,
              id: generateId(now),
              isDeleted: false,
              name: input.name,
              normalizedName,
              revision: 1,
              updatedAt: timestamp,
              updatedById: userId,
              userId,
            })
            .returning(promptSelection())
            .get();
          const presented = presentPrompt(inserted);
          producer.produce(
            userId,
            [
              ensureAccount(userId),
              operationEntityIntent("prompts", inserted.id, "prompt.create", {
                name: input.name,
                body: input.body,
              }),
            ],
            now,
          );
          return presented;
        });
      } catch (error) {
        return rethrowPromptWriteError(error);
      }
    },

    get: (userId, promptId) => {
      const stored = database.query.prompts
        .findFirst({
          columns: promptColumns(),
          where: activePromptCondition(userId, promptId),
        })
        .sync();
      return stored === undefined ? undefined : presentPrompt(stored);
    },

    list: (userId) =>
      database
        .select(promptSelection())
        .from(prompts)
        .where(activePromptCondition(userId))
        .orderBy(asc(prompts.createdAt), asc(prompts.id))
        .all()
        .map(presentPrompt),

    remove: (userId, promptId, now, revision) =>
      database.transaction(() => {
        const changed = changedOwnedPrompt(userId, promptId, revision);
        const removed = database
          .update(prompts)
          .set({
            ...softDeletedAuditFields(userId, now),
            revision: changed.revision,
          })
          .where(changed.condition)
          .returning({ id: prompts.id })
          .all();
        if (removed.length > 0) {
          producer.produce(
            userId,
            [
              ensureAccount(userId),
              operationEntityIntent("prompts", promptId, "prompt.delete", {}),
            ],
            now,
          );
          return true;
        }
        throwIfChanged(userId, promptId, revision);
        return false;
      }),

    update: (userId, promptId, input, now, revision) => {
      try {
        return database.transaction(() => {
          const previous = database
            .select({ body: prompts.body, name: prompts.name })
            .from(prompts)
            .where(currentPromptCondition(userId, promptId, revision))
            .get();
          const changed = changedOwnedPrompt(userId, promptId, revision);
          const normalizedName = promptNameKey(input.name);
          const duplicateId = storedPromptId([
            database,
            promptNameCondition(userId, normalizedName),
          ]);
          if (duplicateId !== undefined && duplicateId !== promptId) {
            throw createPromptStoreError("duplicate_prompt_name");
          }
          const [stored] = database
            .update(prompts)
            .set({
              ...updatedAuditFields(userId, now),
              body: input.body,
              name: input.name,
              normalizedName,
              revision: changed.revision,
            })
            .where(changed.condition)
            .returning(promptSelection())
            .all();
          if (stored === undefined) {
            throwIfChanged(userId, promptId, revision);
          }
          if (stored !== undefined && previous !== undefined) {
            const intents = [];
            if (input.name !== previous.name)
              intents.push(
                operationEntityIntent(
                  "prompts",
                  promptId,
                  "prompt.name.set",
                  { value: input.name },
                  previous,
                ),
              );
            if (input.body !== previous.body)
              intents.push(
                operationEntityIntent(
                  "prompts",
                  promptId,
                  "prompt.body.set",
                  { value: input.body },
                  previous,
                ),
              );
            if (intents.length > 0)
              producer.produce(
                userId,
                [ensureAccount(userId), ...intents],
                now,
              );
          }
          return stored === undefined ? undefined : presentPrompt(stored);
        });
      } catch (error) {
        return rethrowPromptWriteError(error);
      }
    },
  };
}
