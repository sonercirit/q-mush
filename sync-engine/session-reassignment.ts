import { isRecord } from "../shared/auth-model.ts";
import {
  readIdentifier,
  readWorkingDirectory,
} from "./session-request-helpers.ts";

export interface SessionReassignmentInput {
  readonly runnerId: string;
  readonly workingDirectory: string;
}

export function readSessionReassignment(
  value: unknown,
): SessionReassignmentInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runnerId = readIdentifier(value["runnerId"]);
  const workingDirectory = readWorkingDirectory(value);
  return runnerId === undefined || workingDirectory === undefined
    ? undefined
    : { runnerId, workingDirectory };
}
