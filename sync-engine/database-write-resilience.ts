import type {
  Changes,
  Database,
  SQLQueryBindings,
  Statement,
} from "bun:sqlite";
import type { AppDatabase } from "../shared/database.ts";
import type { EngineHealthSnapshot } from "../shared/engine-health.ts";

const SQLITE_FULL_CODE = "SQLITE_FULL";
const SQLITE_FULL_ERRNO = 13;
const CRITICAL_RETRY_DELAYS_MS = [100, 400, 1_500] as const;
const RECOVERY_PROBE_INTERVAL_MS = 30_000;
const WRITE_STATEMENT_PATTERN = /^\s*(?:delete|insert|replace|update)\b/iu;

export type DatabaseWritePriority = "critical" | "noncritical";

type DatabaseWriteAttemptRunner = <Result>(operation: () => Result) => Result;
type RetrySleep = (delay: number) => void;

type DatabaseWriteAttempt<Result> =
  | { readonly result: Result; readonly status: "persisted" }
  | { readonly error: unknown; readonly status: "disk_full" };

export interface StorageHealth {
  degrade(
    reason: "disk_full" | "low_disk_space",
    message: string,
    error?: unknown,
  ): void;
  restore(reason: "disk_full" | "low_disk_space"): void;
  snapshot?(): EngineHealthSnapshot;
}

export interface DatabaseWriteResilienceOptions {
  readonly attempt?: DatabaseWriteAttemptRunner;
  readonly health: StorageHealth;
  readonly sleep?: RetrySleep;
}

export function isDiskFullFailure(error: unknown): boolean {
  return error instanceof DiskFullError;
}

class DiskFullError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("The database write failed because the disk is full");
    this.name = "DiskFullError";
    this.cause = cause;
  }
}

function isDiskFullError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code: unknown = Reflect.get(error, "code");
  const errno: unknown = Reflect.get(error, "errno");
  const message: unknown = Reflect.get(error, "message");
  if (
    code === SQLITE_FULL_CODE ||
    code === "ENOSPC" ||
    errno === SQLITE_FULL_ERRNO ||
    errno === -28 ||
    (typeof message === "string" &&
      /database or disk is full|ENOSPC/iu.test(message))
  ) {
    return true;
  }
  return "cause" in error && isDiskFullError(error.cause);
}

function droppedChanges(): Changes {
  return { changes: 0, lastInsertRowid: 0 };
}

function closedError(): Error {
  return new Error("Database write resilience has shut down");
}

export class DatabaseWriteResilience {
  readonly #attempt: DatabaseWriteAttemptRunner;
  readonly #health: StorageHealth;
  readonly #sleep: RetrySleep;
  #closed = false;

  constructor(options: DatabaseWriteResilienceOptions) {
    this.#attempt = options.attempt ?? ((operation) => operation());
    this.#health = options.health;
    this.#sleep = options.sleep ?? Bun.sleepSync;
  }

  close(): void {
    this.#closed = true;
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw closedError();
    }
  }

  #perform<Result>(operation: () => Result): DatabaseWriteAttempt<Result> {
    try {
      return { result: this.#attempt(operation), status: "persisted" };
    } catch (error) {
      if (!isDiskFullError(error)) {
        throw error;
      }
      return { error, status: "disk_full" };
    }
  }

  run<Result>(
    priority: DatabaseWritePriority,
    operation: () => Result,
  ): Result | undefined {
    this.#throwIfClosed();
    let attempted = this.#perform(operation);
    if (attempted.status === "persisted") {
      return attempted.result;
    }
    this.#health.degrade(
      "disk_full",
      priority === "critical"
        ? "a critical database write ran out of space and is retrying briefly"
        : "a non-critical database write was dropped because the disk is full",
      attempted.error,
    );
    if (priority === "noncritical") {
      return undefined;
    }

    // Bun SQLite and Drizzle are synchronous. Keeping retries synchronous is
    // the only way to return an honest result to their callers. This bounded
    // two-second window may delay the event loop (and signal callbacks), but it
    // cannot monopolize it indefinitely; callers then receive DiskFullError.
    for (const delay of CRITICAL_RETRY_DELAYS_MS) {
      this.#sleep(delay);
      attempted = this.#perform(operation);
      if (attempted.status === "persisted") {
        this.#health.restore("disk_full");
        return attempted.result;
      }
    }
    this.#health.degrade(
      "disk_full",
      "a critical database write still cannot persist after bounded retries",
      attempted.error,
    );
    throw new DiskFullError(attempted.error);
  }
}

export function runNoncriticalDatabaseWrite(
  database: AppDatabase,
  action: () => void,
): void {
  database.noncriticalWrite(action);
}

type StatementMethod = "all" | "get" | "run" | "values";

function isStatementMethod(value: PropertyKey): value is StatementMethod {
  return (
    value === "all" || value === "get" || value === "run" || value === "values"
  );
}

function defaultStatementResult(method: StatementMethod): unknown {
  switch (method) {
    case "get":
      return null;
    case "run":
      return droppedChanges();
    case "all":
    case "values":
      return [];
  }
}

function resilientStatement<ReturnType, ParamsType extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  statement: Statement<ReturnType, ParamsType>,
  resilience: DatabaseWriteResilience,
  priority: () => DatabaseWritePriority,
  inResilientTransaction: () => boolean,
): Statement<ReturnType, ParamsType> {
  const mutation = WRITE_STATEMENT_PATTERN.test(sql);
  return new Proxy(statement, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (
        !isStatementMethod(property) ||
        typeof method !== "function" ||
        (property !== "run" && !mutation)
      ) {
        if (typeof method !== "function") {
          return method;
        }
        const boundMethod: (...parameters: unknown[]) => unknown = (
          ...parameters
        ) => Reflect.apply(method, target, parameters);
        return boundMethod;
      }
      return (...parameters: ParamsType) => {
        const execute = (): unknown =>
          Reflect.apply(method, target, parameters);
        const priorityValue = priority();
        if (database.inTransaction || inResilientTransaction()) {
          return execute();
        }
        const result = resilience.run(priorityValue, execute);
        return priorityValue === "noncritical" && result === undefined
          ? defaultStatementResult(property)
          : result;
      };
    },
  });
}

export function installDatabaseWriteResilience(
  database: AppDatabase,
  resilience: DatabaseWriteResilience,
): void {
  const client = database.$client;
  const prepare = client.prepare.bind(client);
  let activePriority: DatabaseWritePriority = "critical";
  Object.defineProperty(client, "prepare", {
    configurable: true,
    value: <
      ReturnType,
      ParamsType extends SQLQueryBindings | SQLQueryBindings[],
    >(
      sql: string,
      params?: ParamsType,
    ) =>
      resilientStatement(
        client,
        sql,
        prepare<ReturnType, ParamsType>(sql, params),
        resilience,
        () => activePriority,
        () => resilientTransactionDepth > 0,
      ),
  });
  const transaction = database.transaction.bind(database);
  let resilientTransactionDepth = 0;
  function resilientTransaction<Result>(
    transactionAction: (
      transactionDatabase: Parameters<
        Parameters<AppDatabase["transaction"]>[0]
      >[0],
    ) => Result,
    config?: { behavior?: "deferred" | "exclusive" | "immediate" },
  ): Result | undefined {
    const execute = () => {
      resilientTransactionDepth += 1;
      try {
        return transaction(transactionAction, config);
      } finally {
        resilientTransactionDepth -= 1;
      }
    };
    return resilience.run(activePriority, execute);
  }
  Object.defineProperty(database, "transaction", {
    configurable: true,
    value: resilientTransaction,
  });
  Object.defineProperty(database, "noncriticalWrite", {
    configurable: true,
    value: (action: () => void) => {
      const previous = activePriority;
      activePriority = "noncritical";
      try {
        action();
      } finally {
        activePriority = previous;
      }
    },
  });
}

export function startDatabaseRecoveryWatcher(
  database: Database,
  health: StorageHealth,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!health.snapshot?.().reasons.includes("disk_full")) {
      return;
    }
    try {
      // This health-only probe never stands in for a caller's write. The
      // savepoint keeps it quick and leaves no durable application mutation.
      const originalVersion = database
        .query("PRAGMA user_version")
        .values()[0]?.[0];
      if (typeof originalVersion !== "number") {
        throw new Error("The database recovery probe could not read its state");
      }
      database.run("SAVEPOINT q_mush_storage_recovery_probe");
      database.run(
        `PRAGMA user_version = ${String(originalVersion === 0 ? 1 : 0)}`,
      );
      database.run("ROLLBACK TO q_mush_storage_recovery_probe");
      database.run("RELEASE q_mush_storage_recovery_probe");
      health.restore("disk_full");
    } catch (error) {
      try {
        database.run("ROLLBACK TO q_mush_storage_recovery_probe");
        database.run("RELEASE q_mush_storage_recovery_probe");
      } catch {
        // The original probe error describes the storage condition.
      }
      health.degrade(
        "disk_full",
        "the database recovery probe still cannot write to disk",
        error,
      );
    }
  }, RECOVERY_PROBE_INTERVAL_MS);
}
