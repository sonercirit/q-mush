import { expect } from "vitest";
import type { AppDatabase } from "../shared/database";
import { SYSTEM_ID } from "../shared/ids";
import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { operationFingerprint, type Operation } from "../shared/operation-core";
import { operationEntityProjectionCodec } from "../shared/operation-projection";
import type { createOperationIntake } from "../sync-engine/operation-intake";
import { testSessionOperation } from "./operation-core-test-support";

export type TestOperationIntake = ReturnType<typeof createOperationIntake>;

export const expectSessionIntakeRejection = (
  intake: TestOperationIntake,
): void => {
  expect(() =>
    intake.apply(
      "owner-1",
      "session",
      [testSessionOperation("writer-a", 1n, "session")],
      SYSTEM_ID,
      2,
    ),
  ).toThrow(/kind|entity/);
};

export const decodeStoredOperation = (encoded: string): Operation =>
  decodeOperationEnvelope(encoded);

export const expectCheckpointOperationFingerprint = (
  encodedCheckpoint: string,
  expected: string | undefined,
): void => {
  const checkpoint = decodeOperationCheckpoint(
    encodedCheckpoint,
    operationEntityProjectionCodec,
  );
  expect(operationFingerprint(checkpoint.replayHead?.operation)).toBe(expected);
};

export const expectWorkspaceName = (
  projection: {
    readonly workspaces: readonly {
      readonly name: { readonly value: string } | undefined;
    }[];
  },
  expected: string,
): void => {
  expect(projection.workspaces[0]?.name?.value).toBe(expected);
};

export const expectWorkspaceProjectionName = (
  encodedCheckpoint: string,
  expected: string,
): void => {
  const state = decodeOperationCheckpoint(
    encodedCheckpoint,
    operationEntityProjectionCodec,
  );
  expectWorkspaceName(state.projection, expected);
};

export const expectIdempotentCheckpoint = (
  intake: TestOperationIntake,
  operation: Operation,
  encodedCheckpoint: string,
): void => {
  expect(
    intake.apply("owner-1", "non-session", [operation], SYSTEM_ID, 3)
      .encodedCheckpoint,
  ).toBe(encodedCheckpoint);
};

export const firstEnvelopeEncoding = (database: AppDatabase): string => {
  const row = database.$client
    .query<{ encoded_envelope: string }, []>(
      "SELECT encoded_envelope FROM operation_envelopes LIMIT 1",
    )
    .get();
  return row?.encoded_envelope ?? "";
};
