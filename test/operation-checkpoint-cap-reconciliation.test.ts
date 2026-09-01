import { expect, test } from "vitest";

import { encodeOperationCheckpoint } from "../shared/operation-checkpoint";
import { MAX_OPERATION_CHECKPOINT_BYTES } from "../shared/operation-core";
import { initialOperationApplyState } from "../shared/operation-intake-core";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  reduceOperationEntityProjection,
} from "../shared/operation-projection";
import { stabilizeOperationApplyState } from "../shared/operation-stability";
import {
  PROMPT_BODY_MAXIMUM_BYTES,
  PROMPT_MAXIMUM_COUNT,
} from "../shared/prompt-model";
import { applyOperationList } from "./operation-core-test-support";
import { producerOperation } from "./operation-producer-test-support";

const WORST_ESCAPED_BODY = "\0".repeat(PROMPT_BODY_MAXIMUM_BYTES);

test("checkpoint cap fits the maximum worst-case prompt bank with replay headroom", () => {
  const operations = Array.from(
    { length: PROMPT_MAXIMUM_COUNT },
    (_, index) => ({
      ...producerOperation(
        "owner-1",
        `prompt-${String(index)}`,
        BigInt(index + 1),
        index + 1,
      ),
      parents: index === 0 ? {} : { "owner-1": BigInt(index) },
      entity: {
        type: "prompts" as const,
        id: `prompt-${String(index)}`,
        accountId: "owner-1",
      },
      kind: "prompt.create" as const,
      payload: { name: "N".repeat(100), body: WORST_ESCAPED_BODY },
    }),
  );
  const applied = applyOperationList(
    operations,
    initialOperationApplyState(initialOperationEntityProjection),
    reduceOperationEntityProjection,
  );
  const state = stabilizeOperationApplyState(
    applied,
    { physicalMs: PROMPT_MAXIMUM_COUNT + 1, logical: 0, writerId: "owner-1" },
    reduceOperationEntityProjection,
  );
  const bankBytes = Buffer.byteLength(
    encodeOperationCheckpoint(state, operationEntityProjectionCodec),
    "utf8",
  );
  expect(bankBytes).toBeLessThan(MAX_OPERATION_CHECKPOINT_BYTES);
  expect(MAX_OPERATION_CHECKPOINT_BYTES - bankBytes).toBeGreaterThan(
    10 * 1024 * 1024,
  );
});
