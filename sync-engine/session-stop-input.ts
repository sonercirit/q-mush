import { isRecord } from "../shared/auth-model.ts";

export function readSessionStopCascade(value: unknown): boolean | undefined {
  if (value === undefined) return true;
  return typeof value === "boolean" ? value : undefined;
}

export function readSessionStopInput(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  if ("cascade" in value) {
    return Object.keys(value).length === 1
      ? readSessionStopCascade(value["cascade"])
      : undefined;
  }
  return Object.keys(value).length === 0 ? true : undefined;
}
