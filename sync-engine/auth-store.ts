import { and, eq, gt, lte, type SQL } from "drizzle-orm";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AppDatabase } from "../shared/database.ts";
import { sessions, users, workspaces } from "../shared/database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { DEFAULT_WORKSPACE_NAME } from "../shared/workspace-model.ts";

export interface GoogleUserProfile {
  readonly email: string;
  readonly googleSubject: string;
  readonly name: string;
  readonly picture?: string;
}

interface StoredProfile {
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

interface StoredUser extends StoredProfile {
  readonly id: string;
}

function toStoredProfile(profile: GoogleUserProfile): StoredProfile {
  return {
    email: profile.email,
    name: profile.name,
    picture: profile.picture ?? null,
  };
}

function activeSessionCondition(token: string): SQL | undefined {
  return and(eq(sessions.token, token), eq(sessions.isDeleted, false));
}

function toAuthenticatedUser(user: StoredUser): AuthenticatedUser {
  const { picture, ...requiredFields } = user;
  return picture === null ? requiredFields : { ...requiredFields, picture };
}

export class DrizzleAuthStore {
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#database = database;
    this.#generateId = generateId;
  }

  createSession(
    token: string,
    profile: GoogleUserProfile,
    expiresAt: number,
    now: number,
  ): void {
    const timestamp = new Date(now);
    const storedProfile = toStoredProfile(profile);

    this.#database.transaction((transaction) => {
      const existingUser = transaction
        .select({ id: users.id, isDeleted: users.isDeleted })
        .from(users)
        .where(eq(users.googleSubject, profile.googleSubject))
        .get();
      let userId: string;

      if (existingUser === undefined) {
        userId = this.#generateId(now);
        transaction
          .insert(users)
          .values({
            ...storedProfile,
            createdAt: timestamp,
            createdById: SYSTEM_ID,
            googleSubject: profile.googleSubject,
            id: userId,
            isDeleted: false,
            updatedAt: timestamp,
            updatedById: SYSTEM_ID,
          })
          .run();
        transaction
          .insert(workspaces)
          .values({
            createdAt: timestamp,
            createdById: userId,
            id: this.#generateId(now),
            isDefault: true,
            isDeleted: false,
            name: DEFAULT_WORKSPACE_NAME,
            updatedAt: timestamp,
            updatedById: userId,
            userId,
          })
          .run();
      } else {
        if (existingUser.isDeleted) {
          throw new Error("The user has been deleted");
        }

        userId = existingUser.id;
        transaction
          .update(users)
          .set({
            ...storedProfile,
            updatedAt: timestamp,
            updatedById: SYSTEM_ID,
          })
          .where(eq(users.id, userId))
          .run();
      }

      transaction
        .insert(sessions)
        .values({
          createdAt: timestamp,
          createdById: userId,
          expiresAt: new Date(expiresAt),
          id: this.#generateId(now),
          isDeleted: false,
          token,
          updatedAt: timestamp,
          updatedById: userId,
          userId,
        })
        .run();
    });
  }

  expireSessions(now: number): void {
    this.#softDeleteSessions(
      and(
        eq(sessions.isDeleted, false),
        lte(sessions.expiresAt, new Date(now)),
      ),
      SYSTEM_ID,
      now,
    );
  }

  revokeSession(token: string, now: number): void {
    const session = this.#database
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .where(activeSessionCondition(token))
      .get();

    if (session === undefined) {
      return;
    }

    this.#softDeleteSessions(eq(sessions.id, session.id), session.userId, now);
  }

  readSessionUser(token: string, now: number): AuthenticatedUser | null {
    const user = this.#database
      .select({
        email: users.email,
        id: users.id,
        name: users.name,
        picture: users.picture,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          activeSessionCondition(token),
          gt(sessions.expiresAt, new Date(now)),
          eq(users.isDeleted, false),
        ),
      )
      .get();

    return user === undefined ? null : toAuthenticatedUser(user);
  }

  #softDeleteSessions(
    condition: SQL | undefined,
    updatedById: string,
    now: number,
  ): void {
    this.#database
      .update(sessions)
      .set({
        isDeleted: true,
        updatedAt: new Date(now),
        updatedById,
      })
      .where(condition)
      .run();
  }
}
