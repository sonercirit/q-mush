export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
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
  maximumLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

export function readBoundedTrimmedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

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
  for (const key in value) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  return true;
}

export function abortSignalError(signal: AbortSignal, message: string): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException(message, "AbortError");
}
