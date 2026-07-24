import type { UserRealtimeCommand } from "../shared/user-realtime-protocol.ts";

interface RealtimeCommandSuccess {
  readonly commandId: string;
  readonly result: unknown;
  readonly type: "command_success";
}

interface RealtimeCommandError {
  readonly commandId: string;
  readonly error: string;
  readonly type: "command_error";
}

export type RealtimeCommandAcknowledgement =
  RealtimeCommandError | RealtimeCommandSuccess;

interface LedgerEntry {
  readonly command: string;
  expiresAt: number;
  readonly result: Promise<
    | { readonly result: unknown; readonly type: "command_success" }
    | { readonly error: string; readonly type: "command_error" }
  >;
}

function commandFingerprint(command: UserRealtimeCommand): string {
  return JSON.stringify({
    operation: command.operation,
    payload: command.payload,
  });
}

function safeError(error: unknown): string {
  return error instanceof RealtimeCommandFailure
    ? error.code
    : "command_failed";
}

export class RealtimeCommandFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RealtimeCommandFailure";
    this.code = code;
  }
}

export class RealtimeCommandLedger {
  readonly #entries = new Map<string, LedgerEntry>();
  readonly #maximumEntries: number;
  readonly #maximumPendingEntries: number;
  readonly #now: () => number;
  #pendingEntries = 0;
  readonly #retentionMs: number;

  constructor(
    options: {
      readonly maximumEntries?: number;
      readonly maximumPendingEntries?: number;
      readonly now?: () => number;
      readonly retentionMs?: number;
    } = {},
  ) {
    this.#maximumEntries = options.maximumEntries ?? 10_000;
    this.#maximumPendingEntries =
      options.maximumPendingEntries ?? this.#maximumEntries;
    if (this.#maximumEntries < 1 || this.#maximumPendingEntries < 1) {
      throw new RangeError("Realtime command ledger limits must be positive");
    }
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;
  }

  #pruneExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }

  #makeRoom(): boolean {
    while (this.#entries.size >= this.#maximumEntries) {
      const oldest = [...this.#entries].find(
        ([, entry]) => entry.expiresAt !== Number.POSITIVE_INFINITY,
      )?.[0];
      if (oldest === undefined) {
        return false;
      }
      this.#entries.delete(oldest);
    }
    return true;
  }

  async execute(
    userId: string,
    command: UserRealtimeCommand,
    execute: () => unknown,
  ): Promise<RealtimeCommandAcknowledgement> {
    const key = `${userId}:${command.idempotencyKey}`;
    const now = this.#now();
    this.#pruneExpired(now);
    const fingerprint = commandFingerprint(command);
    const existing = this.#entries.get(key);

    if (existing !== undefined && existing.command !== fingerprint) {
      return {
        commandId: command.commandId,
        error: "idempotency_conflict",
        type: "command_error",
      };
    }

    if (
      existing === undefined &&
      (this.#pendingEntries >= this.#maximumPendingEntries || !this.#makeRoom())
    ) {
      return {
        commandId: command.commandId,
        error: "command_capacity_exceeded",
        type: "command_error",
      };
    }

    const entry =
      existing ??
      (() => {
        this.#pendingEntries += 1;
        const created: LedgerEntry = {
          command: fingerprint,
          expiresAt: Number.POSITIVE_INFINITY,
          result: Promise.resolve()
            .then(execute)
            .then(
              (result) => ({ result, type: "command_success" as const }),
              (error: unknown) => ({
                error: safeError(error),
                type: "command_error" as const,
              }),
            ),
        };
        void created.result.then(() => {
          this.#pendingEntries -= 1;
          created.expiresAt = this.#now() + this.#retentionMs;
        });
        this.#entries.set(key, created);
        return created;
      })();
    const result = await entry.result;
    return { commandId: command.commandId, ...result };
  }
}
