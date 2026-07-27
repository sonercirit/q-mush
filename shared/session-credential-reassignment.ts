import { isRecord } from "./auth-model.ts";

export interface SessionCredentialReassignmentResult {
  readonly migratedSessionCount: number;
}

export interface SessionCredentialReassignmentRequest {
  readonly workspaceId?: string;
}

export function readSessionCredentialReassignmentResult(
  value: unknown,
): SessionCredentialReassignmentResult {
  const migratedSessionCount = isRecord(value)
    ? value["migratedSessionCount"]
    : undefined;

  if (
    typeof migratedSessionCount !== "number" ||
    !Number.isSafeInteger(migratedSessionCount) ||
    migratedSessionCount < 0
  ) {
    throw new Error(
      "The server returned an invalid session reassignment result",
    );
  }

  return { migratedSessionCount };
}
