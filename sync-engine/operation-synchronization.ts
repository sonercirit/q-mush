import type { AppDatabase } from "../shared/database.ts";
import { decodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import {
  MAX_OPERATION_BATCH_SIZE,
  type OperationPartition,
} from "../shared/operation-core.ts";
import type { GoogleAuth } from "./auth.ts";
import { parseRecordJsonForMethod } from "./http.ts";
import { createOperationIntake } from "./operation-intake.ts";

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
    !envelopes.every((value) => typeof value === "string")
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
      const operations = parsed.envelopes.map(decodeOperationEnvelope);
      if (
        operations.some(
          (operation) =>
            operation.entity.accountId !== user.id ||
            operation.writerId !== user.id,
        )
      )
        return new Response("Forbidden", { status: 403 });
      const result = intake.apply(
        user.id,
        parsed.partition,
        operations,
        (projection, operation) => [...projection, operation.operationId],
        user.id,
        Date.now(),
      );
      return Response.json({
        checkpoint: result.encodedCheckpoint,
        frontier: Object.fromEntries(
          Object.entries(result.frontier).map(([writerId, sequence]) => [
            writerId,
            sequence.toString(),
          ]),
        ),
      });
    } catch {
      return Response.json(
        { error: "Invalid operation batch" },
        { status: 400 },
      );
    }
  };
};
