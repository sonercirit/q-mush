import { and, asc, eq, type SQL } from "drizzle-orm";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { prompts } from "../shared/database/schema.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import type { Prompt, PromptInput } from "../shared/prompt-model.ts";

export class DuplicatePromptNameError extends Error {
  constructor() {
    super("An active prompt with that name already exists");
    this.name = "DuplicatePromptNameError";
  }
}

function normalizedPromptName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
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

function promptSelection() {
  return {
    body: prompts.body,
    createdAt: prompts.createdAt,
    id: prompts.id,
    name: prompts.name,
    updatedAt: prompts.updatedAt,
  };
}

function promptColumns() {
  return {
    body: true,
    createdAt: true,
    id: true,
    name: true,
    updatedAt: true,
  } as const;
}

type StoredPrompt =
  ReturnType<typeof promptSelection> extends infer Selection
    ? {
        readonly [Key in keyof Selection]: Key extends "createdAt" | "updatedAt"
          ? Date
          : string;
      }
    : never;

function presentPrompt(stored: StoredPrompt): Prompt {
  return {
    body: stored.body,
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    name: stored.name,
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
  };

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#resources = { database, generateId };
  }

  get #database(): AppDatabase {
    return this.#resources.database;
  }

  #newPromptId(now: number): string {
    return this.#resources.generateId(now);
  }

  create(userId: string, input: PromptInput, now: number): Prompt {
    try {
      const stored = this.#database
        .insert(prompts)
        .values({
          ...createdAuditFields(userId, now),
          body: input.body,
          id: this.#newPromptId(now),
          name: input.name,
          normalizedName: normalizedPromptName(input.name),
          userId,
        })
        .returning(promptSelection())
        .get();
      return presentPrompt(stored);
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

  remove(userId: string, promptId: string, now: number): boolean {
    return (
      this.#database
        .update(prompts)
        .set(softDeletedAuditFields(userId, now))
        .where(activePromptCondition(userId, promptId))
        .returning({ id: prompts.id })
        .all().length > 0
    );
  }

  update(
    userId: string,
    promptId: string,
    input: PromptInput,
    now: number,
  ): Prompt | undefined {
    try {
      const [stored] = this.#database
        .update(prompts)
        .set({
          ...updatedAuditFields(userId, now),
          body: input.body,
          name: input.name,
          normalizedName: normalizedPromptName(input.name),
        })
        .where(activePromptCondition(userId, promptId))
        .returning(promptSelection())
        .all();
      return stored === undefined ? undefined : presentPrompt(stored);
    } catch (error) {
      return rethrowPromptWriteError(error);
    }
  }
}
