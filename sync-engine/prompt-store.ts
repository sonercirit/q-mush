import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { softDeletedAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { prompts } from "../shared/database/schema.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import {
  PROMPT_MAXIMUM_COUNT,
  promptNameKey,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import {
  PROMPT_STATE_SELECTION,
  promptStateCondition,
  storedPromptId,
} from "./prompt-query.ts";

export class DuplicatePromptNameError extends Error {
  constructor() {
    super("An active prompt with that name already exists");
    this.name = "DuplicatePromptNameError";
  }
}

export class PromptChangedError extends Error {
  constructor() {
    super("The prompt changed after it was read");
    this.name = "PromptChangedError";
  }
}

export class PromptLimitError extends Error {
  constructor() {
    super("The active prompt limit has been reached");
    this.name = "PromptLimitError";
  }
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
    throw new DuplicatePromptNameError();
  }
  throw error;
}

export class PromptStore {
  readonly #resources: {
    readonly database: AppDatabase;
    readonly generateId: IdGenerator;
    readonly maximumCount: number;
  };

  constructor(
    database: AppDatabase,
    generateId: IdGenerator = createUuidV7,
    maximumCount = PROMPT_MAXIMUM_COUNT,
  ) {
    this.#resources = { database, generateId, maximumCount };
  }

  get #database(): AppDatabase {
    return this.#resources.database;
  }

  create(userId: string, input: PromptInput, now: number): Prompt {
    try {
      return this.#database.transaction((transaction) => {
        const storedCount = transaction
          .select({ count: sql<number>`count(*)` })
          .from(prompts)
          .where(activePromptCondition(userId))
          .get();
        if ((storedCount?.count ?? 0) >= this.#resources.maximumCount) {
          throw new PromptLimitError();
        }
        const normalizedName = promptNameKey(input.name);
        if (
          storedPromptId([
            transaction,
            promptNameCondition(userId, normalizedName),
          ]) !== undefined
        ) {
          throw new DuplicatePromptNameError();
        }
        const timestamp = new Date(now);
        const inserted = transaction
          .insert(prompts)
          .values({
            body: input.body,
            createdAt: timestamp,
            createdById: userId,
            id: this.#resources.generateId(now),
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
        return presentPrompt(inserted);
      });
    } catch (error) {
      return rethrowPromptWriteError(error);
    }
  }

  get(userId: string, promptId: string): Prompt | undefined {
    const stored = this.#database.query.prompts
      .findFirst({
        columns: promptColumns(),
        where: activePromptCondition(userId, promptId),
      })
      .sync();
    return stored === undefined ? undefined : presentPrompt(stored);
  }

  list(userId: string): readonly Prompt[] {
    return this.#database
      .select(promptSelection())
      .from(prompts)
      .where(activePromptCondition(userId))
      .orderBy(asc(prompts.createdAt), asc(prompts.id))
      .all()
      .map(presentPrompt);
  }

  remove(
    userId: string,
    promptId: string,
    now: number,
    revision: number,
  ): boolean {
    const changed = changedOwnedPrompt(userId, promptId, revision);
    const removed = this.#database
      .update(prompts)
      .set({
        ...softDeletedAuditFields(userId, now),
        revision: changed.revision,
      })
      .where(changed.condition)
      .returning({ id: prompts.id })
      .all();
    if (removed.length > 0) {
      return true;
    }
    this.#throwIfChanged(userId, promptId, revision);
    return false;
  }

  update(
    userId: string,
    promptId: string,
    input: PromptInput,
    now: number,
    revision: number,
  ): Prompt | undefined {
    try {
      const changed = changedOwnedPrompt(userId, promptId, revision);
      const normalizedName = promptNameKey(input.name);
      const duplicateId = storedPromptId([
        this.#database,
        promptNameCondition(userId, normalizedName),
      ]);
      if (duplicateId !== undefined && duplicateId !== promptId) {
        throw new DuplicatePromptNameError();
      }
      const [stored] = this.#database
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
        this.#throwIfChanged(userId, promptId, revision);
      }
      return stored === undefined ? undefined : presentPrompt(stored);
    } catch (error) {
      return rethrowPromptWriteError(error);
    }
  }

  #throwIfChanged(userId: string, promptId: string, revision: number): void {
    const stored = this.#database
      .select(PROMPT_STATE_SELECTION)
      .from(prompts)
      .where(promptStateCondition(userId, promptId))
      .get();
    if (
      stored !== undefined &&
      (stored.isDeleted || stored.revision !== revision)
    ) {
      throw new PromptChangedError();
    }
  }
}
