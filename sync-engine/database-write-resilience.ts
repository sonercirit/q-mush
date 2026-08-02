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

type RetryTimer = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof setTimeout>;

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
  readonly setTimeout?: RetryTimer;
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

export class DatabaseWriteResilience {
  readonly #health: StorageHealth;
  readonly #retryTimer: RetryTimer;

  constructor(options: DatabaseWriteResilienceOptions) {
    this.#health = options.health;
    this.#retryTimer = options.setTimeout ?? setTimeout;
  }

  run<Result>(
    priority: DatabaseWritePriority,
    operation: () => Result,
  ): Result | undefined {
    try {
      const result = operation();
      this.#health.restore("disk_full");
      return result;
    } catch (error) {
      if (!isDiskFullError(error)) {
        throw error;
      }
      this.#health.degrade(
        "disk_full",
        priority === "critical"
          ? "a critical database write ran out of space and will be retried"
          : "a non-critical database write was dropped because the disk is full",
        error,
      );
      if (priority === "critical") {
        this.#retry(operation, 0);
      }
      return undefined;
    }
  }

  #retry(operation: () => unknown, attempt: number): void {
    const delay =
      CRITICAL_RETRY_DELAYS_MS[
        Math.min(attempt, CRITICAL_RETRY_DELAYS_MS.length - 1)
      ] ?? CRITICAL_RETRY_DELAYS_MS.at(-1);
    if (delay === undefined) {
      return;
    }
    this.#retryTimer(() => {
      try {
        operation();
        this.#health.restore("disk_full");
      } catch (error) {
        if (!isDiskFullError(error)) {
          console.error("Critical database write retry failed", error);
          return;
        }
        this.#health.degrade(
          "disk_full",
          "a critical database write retry still cannot persist to disk",
          error,
        );
        this.#retry(operation, attempt + 1);
      }
    }, delay);
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
        return method;
      }
      return (...parameters: ParamsType) => {
        const execute = (): unknown =>
          Reflect.apply(method, target, parameters);
        const priorityValue = priority();
        if (database.inTransaction && priorityValue !== "noncritical") {
          return execute();
        }
        return (
          resilience.run(priorityValue, execute) ??
          defaultStatementResult(property)
        );
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
      ),
  });
  const transaction = database.transaction.bind(database);
  function resilientTransaction<Result>(
    transactionAction: (
      transactionDatabase: Parameters<
        Parameters<AppDatabase["transaction"]>[0]
      >[0],
    ) => Result,
    config?: { behavior?: "deferred" | "exclusive" | "immediate" },
  ): Result | undefined {
    return resilience.run(activePriority, () =>
      transaction(transactionAction, config),
    );
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
