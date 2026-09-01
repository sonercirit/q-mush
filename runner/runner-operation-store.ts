import type { Database } from "bun:sqlite";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint.ts";
import {
  frontierCovers,
  isOperationProtocolError,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OPERATION_ENVELOPE_BYTES,
  operationProtocolError,
  type CausalFrontier,
  type HybridTimestamp,
  type OperationApplyState,
  type OperationPartition,
} from "../shared/operation-core.ts";
import {
  applyOperationIntakeBatch,
  initialOperationApplyState,
} from "../shared/operation-intake-core.ts";
import {
  initialOperationEntityProjection,
  operationEntityProjectionCodec,
  reduceOperationEntityProjection,
  type OperationEntityProjection,
} from "../shared/operation-projection.ts";
import {
  stabilizeOperationApplyState,
  type OperationStabilityBoundary,
} from "../shared/operation-stability.ts";
import {
  createRunnerOperationLog,
  type OperationReplicaSource,
} from "./runner-operation-log.ts";

const checkpointByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

export interface RunnerOperationCompactionRequest {
  readonly ownerId: string;
  readonly partition: OperationPartition;
  readonly stableClock: HybridTimestamp | null;
  readonly stableFrontier: CausalFrontier | null;
}

export interface RunnerOperationStoreLimits {
  readonly checkpointBytes?: number;
}

export const createRunnerOperationStore = (
  database: Database,
  limits?: RunnerOperationStoreLimits,
) => {
  const log = createRunnerOperationLog(database);
  const checkpointState = (
    ownerId: string,
    partition: OperationPartition,
  ): OperationApplyState<OperationEntityProjection> => {
    const encoded = log.checkpoint(ownerId, partition);
    return encoded === undefined
      ? initialOperationApplyState(initialOperationEntityProjection)
      : decodeOperationCheckpoint(encoded, operationEntityProjectionCodec);
  };
  return {
    apply(
      ownerId: string,
      partition: OperationPartition,
      envelopes: readonly string[],
      source: OperationReplicaSource,
      stability?: OperationStabilityBoundary,
    ) {
      if (envelopes.length === 0) return;
      if (
        source === "local" &&
        envelopes.some(
          (encoded) =>
            Buffer.byteLength(encoded, "utf8") > MAX_OPERATION_ENVELOPE_BYTES,
        )
      )
        throw operationProtocolError(
          "capacity",
          "Operation envelope capacity reached",
        );
      database.transaction(() => {
        let successor = checkpointState(ownerId, partition);
        let changed = false;
        let stalled = source === "remote" && log.stalled(ownerId, partition);
        for (const encoded of envelopes) {
          let operation: ReturnType<typeof decodeOperationEnvelope>;
          try {
            operation = decodeOperationEnvelope(encoded);
          } catch (error) {
            if (source === "local") throw error;
            log.quarantine(
              ownerId,
              partition,
              encoded,
              error instanceof Error
                ? error.message
                : "Invalid operation envelope",
            );
            changed = true;
            stalled = true;
            continue;
          }
          if (stalled) continue;
          const identity = log.classifyIdentity(ownerId, operation);
          if (identity === "duplicate") continue;
          if (identity === "conflict") {
            if (source === "local")
              throw operationProtocolError(
                "conflict",
                "Operation identity equivocation",
              );
            log.quarantine(
              ownerId,
              partition,
              encoded,
              "Operation identity equivocation",
              operation,
            );
            changed = true;
            stalled = true;
            continue;
          }
          try {
            let acceptedOperation: typeof operation | undefined;
            let candidate = applyOperationIntakeBatch(
              partition,
              successor,
              [{ encoded, operation }],
              {
                append: (_candidate, accepted) => {
                  acceptedOperation = accepted;
                },
                ownsOperation: (accepted) =>
                  source === "remote" ||
                  accepted.entity.accountId === accepted.writerId,
                reducer: reduceOperationEntityProjection,
              },
            );
            if (
              stability?.stableClock != null &&
              stability.stableFrontier != null &&
              frontierCovers(candidate.frontier, stability.stableFrontier)
            )
              candidate = stabilizeOperationApplyState(
                candidate,
                stability.stableClock,
                reduceOperationEntityProjection,
              );
            const encodedCheckpoint = encodeOperationCheckpoint(
              candidate,
              operationEntityProjectionCodec,
            );
            if (
              checkpointByteLength(encodedCheckpoint) >
              (limits?.checkpointBytes ?? MAX_OPERATION_CHECKPOINT_BYTES)
            )
              throw operationProtocolError(
                "capacity",
                "Operation checkpoint capacity reached",
              );
            if (acceptedOperation !== undefined) {
              log.append(ownerId, acceptedOperation, encoded, source);
              changed = true;
            }
            successor = candidate;
          } catch (error) {
            if (source !== "remote" || !isOperationProtocolError(error))
              throw error;
            log.quarantine(
              ownerId,
              partition,
              encoded,
              error.message,
              operation,
            );
            changed = true;
            stalled = true;
          }
        }
        if (changed)
          log.storeCheckpoint(
            ownerId,
            partition,
            encodeOperationCheckpoint(
              successor,
              operationEntityProjectionCodec,
            ),
          );
      })();
    },
    compact(request: RunnerOperationCompactionRequest) {
      const { ownerId, partition, stableClock, stableFrontier } = request;
      if (stableClock === null || stableFrontier === null) return;
      const state = checkpointState(ownerId, partition);
      if (!frontierCovers(state.frontier, stableFrontier)) return;
      const compacted = stabilizeOperationApplyState(
        state,
        stableClock,
        reduceOperationEntityProjection,
      );
      if (compacted === state) return;
      database.transaction(() => {
        log.storeCheckpoint(
          ownerId,
          partition,
          encodeOperationCheckpoint(compacted, operationEntityProjectionCodec),
        );
      })();
    },
    acknowledge: (...arguments_: Parameters<typeof log.acknowledge>) => {
      log.acknowledge(...arguments_);
    },
    inspect: (...arguments_: Parameters<typeof log.inspect>) =>
      log.inspect(...arguments_),
    pending: (...arguments_: Parameters<typeof log.pending>) =>
      log.pending(...arguments_),
    stallOutbox: (...arguments_: Parameters<typeof log.stallOutbox>) => {
      log.stallOutbox(...arguments_);
    },
    state(ownerId: string, partition: OperationPartition) {
      return {
        ...checkpointState(ownerId, partition),
        stalled: log.stalled(ownerId, partition),
        outboxStalls: log.outboxStalls(ownerId, partition),
      };
    },
  };
};
