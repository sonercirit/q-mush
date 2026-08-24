import type { createSessionStore } from "./session-store.ts";

export interface SessionStore extends ReturnType<typeof createSessionStore> {
  readonly __sessionStore?: never;
}
