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
const CRITICAL_RETRY_DELAYS_MS = [100, 500, 2_000, 5_000] as const;
const WRITE_STATEMENT_PATTERN = /^\s*(?:delete|insert|replace|update)\b/iu;

export type DatabaseWritePriority = "critical" | "noncritical";

type RetrySleep = (delay: number, signal: AbortSignal) => Promise<void>;

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
  readonly health: StorageHealth;
  readonly sleep?: RetrySleep;
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

function queueFullError(): Error {
  return new Error(
    "The critical database write retry queue is full; the write was not attempted",
  );
}

function abortableSleep(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(closedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort(): void {
      clearTimeout(timer);
      reject(closedError());
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class DatabaseWriteResilience {
  readonly #controller = new AbortController();
  readonly #health: StorageHealth;
  readonly #sleep: RetrySleep;
  #closed = false;
  #retrying = false;

  constructor(options: DatabaseWriteResilienceOptions) {
    this.#health = options.health;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#controller.abort();
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw closedError();
    }
  }

  #restoreAndReturn<Result>(result: Result): Result {
    this.#health.restore("disk_full");
    return result;
  }

  #perform<Result>(
    operation: () => Result,
    retry: boolean,
  ): DatabaseWriteAttempt<Result> {
    try {
      return {
        result: this.#restoreAndReturn(operation()),
        status: "persisted",
      };
    } catch (error) {
      if (!isDiskFullError(error)) {
        if (retry) {
          this.#health.restore("disk_full");
        }
        throw error;
      }
      return { error, status: "disk_full" };
    }
  }

  run<Result>(
    priority: DatabaseWritePriority,
    operation: () => Result,
  ): Promise<Result> | Result | undefined {
    this.#throwIfClosed();
    // One caller owns the retry slot until its write is durably resolved. The
    // asynchronous wait keeps the engine responsive without retaining an
    // unbounded queue of later write payloads.
    if (this.#retrying) {
      if (priority === "noncritical") {
        return undefined;
      }
      throw queueFullError();
    }
    const attempted = this.#perform(operation, false);
    if (attempted.status === "persisted") {
      return attempted.result;
    }
    this.#health.degrade(
      "disk_full",
      priority === "critical"
        ? "a critical database write ran out of space and is waiting to retry"
        : "a non-critical database write was dropped because the disk is full",
      attempted.error,
    );
    return priority === "noncritical" ? undefined : this.#retry(operation);
  }

  async #retry<Result>(operation: () => Result): Promise<Result> {
    this.#retrying = true;
    let attempt = 0;
    try {
      while (!this.#closed) {
        const delay =
          CRITICAL_RETRY_DELAYS_MS[
            Math.min(attempt, CRITICAL_RETRY_DELAYS_MS.length - 1)
          ];
        if (delay === undefined) {
          throw new Error("The critical database retry policy is invalid");
        }
        await this.#sleep(delay, this.#controller.signal);
        this.#throwIfClosed();
        const attempted = this.#perform(operation, true);
        if (attempted.status === "persisted") {
          return attempted.result;
        }
        this.#health.degrade(
          "disk_full",
          "a critical database write retry still cannot persist to disk",
          attempted.error,
        );
        attempt += 1;
      }
      throw closedError();
    } finally {
      this.#retrying = false;
    }
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
  ): Promise<Result> | Result | undefined {
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
