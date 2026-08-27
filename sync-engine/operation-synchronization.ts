import type { AppDatabase } from "../shared/database";
import { decodeOperationEnvelope } from "../shared/operation-checkpoint";
import {
  isOperationProtocolError,
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_ENVELOPE_BYTES,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  operationProtocolError,
  type OperationPartition,
} from "../shared/operation-core";
import type { GoogleAuth } from "./auth";
import { parseRecordJsonForMethod } from "./http";
import { createOperationIntake } from "./operation-intake";

interface SynchronizationRequest {
  readonly ownerId: string;
  readonly partition: OperationPartition;
  readonly envelopes: readonly string[];
}
const exactKeys = (record: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(record).length === 3 &&
  Object.hasOwn(record, "ownerId") &&
  Object.hasOwn(record, "partition") &&
  Object.hasOwn(record, "envelopes");
const parseRequest = (
  record: Readonly<Record<string, unknown>>,
): SynchronizationRequest | undefined => {
  const ownerId = record["ownerId"];
  const partition = record["partition"];
  const envelopes = record["envelopes"];
  if (
    !exactKeys(record) ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    (partition !== "session" && partition !== "non-session") ||
    !Array.isArray(envelopes) ||
    envelopes.length > MAX_OPERATION_BATCH_SIZE ||
    !envelopes.every(
      (value) =>
        typeof value === "string" &&
        new TextEncoder().encode(value).byteLength <=
          MAX_OPERATION_ENVELOPE_BYTES,
    )
  )
    return undefined;
  return { ownerId, partition, envelopes };
};

export const createOperationSynchronization = (
  database: AppDatabase,
  googleAuth: Pick<GoogleAuth, "authenticatedUser">,
) => {
  const intake = createOperationIntake({ database });
  return async (request: Request): Promise<Response> => {
    const user = googleAuth.authenticatedUser(request);
    if (user === null) return new Response("Unauthorized", { status: 401 });
    const parsed = await parseRecordJsonForMethod(
      request,
      "POST",
      parseRequest,
    );
    if (parsed instanceof Response) return parsed;
    if (parsed === undefined)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    if (parsed.ownerId !== user.id)
      return new Response("Forbidden", { status: 403 });
    try {
      const operations = parsed.envelopes.map((envelope) => {
        try {
          return decodeOperationEnvelope(envelope);
        } catch {
          throw operationProtocolError("invalid", "Invalid operation envelope");
        }
      });
      const now = Date.now();
      if (
        operations.some(
          (operation) =>
            operation.entity.accountId !== user.id ||
            operation.writerId !== user.id,
        )
      )
        return new Response("Forbidden", { status: 403 });
      if (
        operations.some(
          ({ clock }) =>
            Math.abs(clock.physicalMs - now) > MAX_REMOTE_CLOCK_DRIFT_MS,
        )
      )
        return Response.json(
          { error: "Invalid operation batch" },
          { status: 400 },
        );
      const result = intake.apply(
        user.id,
        parsed.partition,
        operations,
        (projection, operation) => [...projection, operation.operationId],
        user.id,
        now,
      );
      return Response.json({
        frontier: Object.fromEntries(
          Object.entries(result.frontier).map(([writerId, sequence]) => [
            writerId,
            sequence.toString(),
          ]),
        ),
      });
    } catch (error) {
      if (isOperationProtocolError(error))
        return Response.json(
          { error: error.message },
          {
            status:
              error.operationError === "conflict"
                ? 409
                : error.operationError === "capacity"
                  ? 507
                  : 400,
          },
        );
      console.error("Operation synchronization failed", error);
      return Response.json(
        { error: "Operation synchronization failed" },
        { status: 500 },
      );
    }
  };
};
