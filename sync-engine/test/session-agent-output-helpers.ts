import { isRecord } from "../../shared/auth-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { boundSessionToolOutput } from "../session-tool-output.ts";

export function boundedStructuredToolOutput(
  output: string,
  maximum: number,
  toolName: string,
): string {
  return boundSessionToolOutput(
    { output, state: "completed" },
    { ...DEFAULT_TOOL_SETTINGS, outputLimitCharacters: maximum },
    toolName,
  ).output;
}

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

export function recordContentsContaining(
  value: unknown,
  expected: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  const candidates: unknown[] = value;
  const matching: Readonly<Record<string, unknown>>[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = candidate["content"];
    if (typeof content === "string" && content.includes(expected)) {
      matching.push(candidate);
    }
  }
  return matching;
}

export function recordContentsContaining(
  value: unknown,
  expected: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  const candidates: unknown[] = value;
  const matching: Readonly<Record<string, unknown>>[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = candidate["content"];
    if (typeof content === "string" && content.includes(expected)) {
      matching.push(candidate);
    }
  }
  return matching;
}

export function records(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  return testArray(value).map(testRecord);
}
