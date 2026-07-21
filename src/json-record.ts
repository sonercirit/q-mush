import { isRecord } from "./auth-model.ts";

export function parseOptionalJsonRecord(message: string) {
  try {
    const parsed: unknown = JSON.parse(message);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseJsonRecord(message: string, errorMessage: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(message);
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(errorMessage);
  }

  return parsed;
}

export function requiredRecordString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  errorMessage: string,
): string {
  const selected = value[key];

  if (typeof selected !== "string") {
    throw new Error(errorMessage);
  }

  return selected;
}
