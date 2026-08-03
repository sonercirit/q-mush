import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import {
  cancelPendingInput,
  enqueuePendingInput,
  settleNormalSessionBoundary,
  takeSteeringInputs,
  type EnqueuePendingInputResult,
  type EnqueuePendingSessionInput,
} from "./session-pending-inputs.ts";

export class SessionInputStore {
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;

  constructor(database: AppDatabase, generateId: IdGenerator) {
    this.#database = database;
    this.#generateId = generateId;
  }

  cancel(options: Omit<Parameters<typeof cancelPendingInput>[0], "database">) {
    return cancelPendingInput({ ...options, database: this.#database });
  }

  enqueue(
    userId: string,
    sessionId: string,
    input: EnqueuePendingSessionInput,
    now: number,
  ): EnqueuePendingInputResult {
    return enqueuePendingInput({
      database: this.#database,
      generateId: this.#generateId,
      input,
      now,
      sessionId,
      userId,
    });
  }

  settle(sessionId: string, now: number, generation: number) {
    return settleNormalSessionBoundary({
      database: this.#database,
      generation,
      now,
      sessionId,
    });
  }

  takeSteering(
    sessionId: string,
    now: number,
  ): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
    return takeSteeringInputs({ database: this.#database, now, sessionId });
  }
}
