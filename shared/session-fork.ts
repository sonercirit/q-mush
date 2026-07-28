import { isRecord } from "./auth-model.ts";
import { readIdentifier } from "./validation.ts";

export interface SessionForkInput {
  readonly forkPointMessageId: string;
  readonly sourceSessionId: string;
  readonly workspaceId: string;
}

export function readSessionForkInput(
  value: unknown,
): SessionForkInput | undefined {
  const record = isRecord(value) ? value : undefined;
  if (record === undefined) {
    return undefined;
  }
  const forkPointMessageId = readIdentifier(record["forkPointMessageId"]);
  const sourceSessionId = readIdentifier(record["sourceSessionId"]);
  const workspaceId = readIdentifier(record["workspaceId"]);
  if (
    Object.keys(record).length !== 3 ||
    forkPointMessageId === undefined ||
    sourceSessionId === undefined ||
    workspaceId === undefined
  ) {
    return undefined;
  }
  return { forkPointMessageId, sourceSessionId, workspaceId };
}
