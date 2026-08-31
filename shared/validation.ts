import { utf8ByteLength } from "./utf8";

export const nullPrototypeRecord = <T>(): Record<string, T> => {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
};

export const isBoundedSafeRecordKey = (
  value: unknown,
  maximumBytes: number,
): value is string =>
  hasSafeRecordKey(value) && utf8ByteLength(value) <= maximumBytes;

export const hasSafeRecordKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "__proto__" &&
  value !== "prototype" &&
  value !== "constructor";

export const assertExactObjectKeys = (
  value: object,
  keys: readonly string[],
  message: string,
): void => {
  if (!exactObjectKeys(value, keys)) throw new Error(message);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const exactObjectKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function requireRecord(
  value: unknown,
  errorMessage: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(errorMessage);
  return value;
}

export function readNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return isNonNegativeSafeInteger(value) ? value : undefined;
}

export function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function isNullOrPositiveSafeInteger(
  value: unknown,
): value is number | null {
  return value === null || readPositiveSafeInteger(value) !== null;
}

export function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z\d._:-]{1,200}$/u.test(value)
    ? value
    : undefined;
}

export function readBoundedString(
  value: unknown,
  options: {
    readonly allowEmpty?: boolean;
    readonly maximumLength: number;
  },
): string | undefined {
  return typeof value === "string" &&
    (options.allowEmpty === true || value.length > 0) &&
    value.length <= options.maximumLength
    ? value
    : undefined;
}

export function readBoundedTrimmedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength
    ? normalized
    : undefined;
}

export function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return false;
  return true;
}

export function errorFromUnknown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function abortSignalError(signal: AbortSignal, message: string): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException(message, "AbortError");
}

export function throwIfSignalAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted === true) throw abortSignalError(signal, message);
}

export interface AbortableOperationOptions {
  readonly abortMessage: string;
  readonly failureMessage?: string;
  readonly onAbort?: () => Promise<void> | void;
}

function abortCleanup(options: AbortableOperationOptions): Promise<void> {
  try {
    return Promise.resolve(options.onAbort?.()).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Races an operation with a signal. Abort rejects promptly after starting
 * best-effort cleanup; settlement never depends on a non-cooperative cleanup
 * hook. Settlement and listener disposal are idempotent, and a late operation
 * rejection always has a handler.
 */
export function executeWithAbortSignal<Value>(
  signal: AbortSignal,
  options: AbortableOperationOptions,
  execute: () => Promise<Value>,
): Promise<Value> {
  const failure = (error: unknown): Error =>
    error instanceof Error
      ? error
      : new Error(options.failureMessage ?? "The operation failed");
  if (signal.aborted) {
    const reason = abortSignalError(signal, options.abortMessage);
    void abortCleanup(options);
    return Promise.reject(reason);
  }
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", aborted);
      finish();
      return true;
    };
    const aborted = (): void => {
      const reason = abortSignalError(signal, options.abortMessage);
      if (
        !settle(() => {
          reject(reason);
        })
      )
        return;
      void abortCleanup(options);
    };
    signal.addEventListener("abort", aborted, { once: true });
    let pending: Promise<Value>;
    try {
      pending = execute();
    } catch (error) {
      const failureReason = failure(error);
      settle(() => {
        reject(failureReason);
      });
      return;
    }
    void pending.then(
      (value) =>
        settle(() => {
          resolve(value);
        }),
      (error: unknown) =>
        settle(() => {
          reject(failure(error));
        }),
    );
  });
}

export function optionalSignal(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}
