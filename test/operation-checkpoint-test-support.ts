import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import type { OperationApplyState } from "../shared/operation-core";

export const expectCheckpointRejection = (
  state: OperationApplyState<readonly string[]>,
  pattern: RegExp,
): void => {
  const encoded = encodeOperationCheckpoint(state);
  let error: unknown;
  try {
    decodeOperationCheckpoint(encoded);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !pattern.test(error.message))
    throw new Error(
      `Expected checkpoint rejection matching ${String(pattern)}`,
    );
};

const parsedTaggedCheckpoint = (
  encoded: string,
): { readonly entries: unknown[]; readonly root: unknown[] } => {
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1]))
    throw new Error("Invalid tagged checkpoint fixture");
  return { entries: parsed[1], root: parsed };
};

export const taggedCheckpointEntries = (encoded: string): unknown[] =>
  parsedTaggedCheckpoint(encoded).entries;

export const mapTaggedCheckpointEntries = (
  encoded: string,
  map: (entries: unknown[]) => unknown[],
): string => {
  const parsed = parsedTaggedCheckpoint(encoded);
  parsed.root[1] = map(parsed.entries);
  return JSON.stringify(parsed.root);
};
