import { isRecord } from "../../shared/auth-model.ts";

export function jsonRecord(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new TypeError("Expected a JSON object");
  }
  return parsed;
}

export function parseTestJson(value: string): unknown {
  return JSON.parse(value);
}

export function testRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  throw new TypeError("Expected a JSON object");
}

export function testArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected a JSON array");
  }
  return value;
}

export function testString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected a string");
  }
  return value;
}

export function testNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError("Expected a number");
  }
  return value;
}

export function records(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  return testArray(value).map(testRecord);
}
