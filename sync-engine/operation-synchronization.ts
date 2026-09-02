import type { AppDatabase } from "../shared/database";
import { decodeOperationEnvelope } from "../shared/operation-checkpoint";
import {
  isOperationProtocolError,
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_ENVELOPE_BYTES,
  MAX_OPERATION_SYNC_BATCH_BYTES,
  operationProtocolError,
  type OperationPartition,
} from "../shared/operation-core";
import {
  parseSynchronizationFrontier,
  prepareSynchronizationFrontier,
} from "../shared/operation-intake-core";
import { utf8ByteLength } from "../shared/utf8";
import { parseRecordJsonForMethod } from "./http";
import {
  createOperationIntake,
  type OperationIntakeLimits,
} from "./operation-intake";
import { createOperationStore } from "./operation-store";
import {
  assertReflectableRunnerOperations,
  backfillRunnerWorkspaceOperations,
  reflectRunnerWorkspaceOperations,
} from "./runner-operation-reflection";
import type { RunnerAccountIdentity } from "./runners";

const MAX_ENVELOPE_PAGE_SIZE = 256;
const MAX_OPERATION_SYNC_REQUEST_BYTES =
  MAX_OPERATION_SYNC_BATCH_BYTES + 1024 * 1024;
const invalidRequest = (): Response =>
  Response.json({ error: "Invalid request" }, { status: 400 });
const readBoundedRequest = async (
  request: Request,
): Promise<Request | Response> => {
  if (request.method !== "POST") return request;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OPERATION_SYNC_REQUEST_BYTES)
    return invalidRequest();
  const reader = request.body?.getReader();
  if (reader === undefined) return request;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let item = await reader.read();
  while (!item.done) {
    bytes += item.value.byteLength;
    if (bytes > MAX_OPERATION_SYNC_REQUEST_BYTES) {
      await reader.cancel();
      return invalidRequest();
    }
    chunks.push(item.value);
    item = await reader.read();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
};
interface SynchronizationRequest {
  readonly ownerId: string;
  readonly partition: OperationPartition;
  readonly envelopes: readonly string[];
}
interface SynchronizationReadRequest {
  readonly ownerId: string;
  readonly partition: OperationPartition;
  readonly frontier: Readonly<Record<string, bigint>>;
}
const parseFrontier = parseSynchronizationFrontier;
const parseScope = (
  record: Readonly<Record<string, unknown>>,
):
  | { readonly ownerId: string; readonly partition: OperationPartition }
  | undefined => {
  const ownerId = record["ownerId"];
  const partition = record["partition"];
  return typeof ownerId === "string" &&
    ownerId.length > 0 &&
    (partition === "session" || partition === "non-session")
    ? { ownerId, partition }
    : undefined;
};
const parseReadRequest = (
  record: Readonly<Record<string, unknown>>,
): SynchronizationReadRequest | undefined => {
  const scope = parseScope(record);
  const frontier = parseFrontier(record["frontier"]);
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, "ownerId") ||
    !Object.hasOwn(record, "partition") ||
    !Object.hasOwn(record, "frontier") ||
    scope === undefined ||
    frontier === undefined
  )
    return undefined;
  return { ...scope, frontier };
};
const exactKeys = (record: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(record).length === 3 &&
  Object.hasOwn(record, "ownerId") &&
  Object.hasOwn(record, "partition") &&
  Object.hasOwn(record, "envelopes");
const parseRequest = (
  record: Readonly<Record<string, unknown>>,
): SynchronizationRequest | undefined => {
  const scope = parseScope(record);
  const envelopes = record["envelopes"];
  if (
    !exactKeys(record) ||
    scope === undefined ||
    !Array.isArray(envelopes) ||
    envelopes.length > MAX_OPERATION_BATCH_SIZE ||
    envelopes.reduce<number>(
      (total, value: unknown) =>
        total + (typeof value === "string" ? utf8ByteLength(value) : 0),
      0,
    ) > MAX_OPERATION_SYNC_BATCH_BYTES ||
    !envelopes.every(
      (value) =>
        typeof value === "string" &&
        utf8ByteLength(value) <= MAX_OPERATION_ENVELOPE_BYTES,
    )
  )
    return undefined;
  return { ...scope, envelopes };
};

export const createOperationSynchronization = (
  database: AppDatabase,
  runnerAuth: {
    readonly runnerAccount: (
      request: Request,
    ) => RunnerAccountIdentity | undefined;
  },
  limits?: OperationIntakeLimits,
) => {
  const intake = createOperationIntake(
    limits === undefined ? { database } : { database, limits },
  );
  const store = createOperationStore({ database });
  return async (request: Request): Promise<Response> => {
    const bounded = await readBoundedRequest(request);
    if (bounded instanceof Response) return bounded;
    request = bounded;
    const runnerUser = runnerAuth.runnerAccount(request);
    if (runnerUser === undefined)
      return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST" && request.method !== "PUT")
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, PUT" },
      });
    const reading = request.method === "PUT";
    const parseSynchronizationRequest = (
      record: Readonly<Record<string, unknown>>,
    ): SynchronizationReadRequest | SynchronizationRequest | undefined =>
      reading ? parseReadRequest(record) : parseRequest(record);
    const parsed = await parseRecordJsonForMethod(
      request,
      reading ? "PUT" : "POST",
      parseSynchronizationRequest,
    );
    if (parsed instanceof Response) return parsed;
    if (parsed === undefined) return invalidRequest();
    const ownerId = runnerUser.userId;
    if (parsed.ownerId !== "self")
      return new Response("Forbidden", { status: 403 });
    try {
      if ("frontier" in parsed) {
        const page = store.readEncodedEnvelopes(
          ownerId,
          parsed.partition,
          parsed.frontier,
          MAX_ENVELOPE_PAGE_SIZE,
        );
        const stability = store.loadStability(ownerId, parsed.partition);
        return Response.json({
          envelopes: page.envelopes,
          hasMore: page.hasMore,
          stableClock: stability.stableClock,
          stableFrontier: stability.stableFrontier,
        });
      }
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
            operation.entity.accountId !== ownerId ||
            operation.writerId !== runnerUser.runnerId,
        )
      )
        return new Response("Forbidden", { status: 403 });
      assertReflectableRunnerOperations(operations);
      const result =
        operations.length === 0
          ? intake.apply(ownerId, parsed.partition, operations, ownerId, now)
          : database.transaction(() => {
              backfillRunnerWorkspaceOperations(
                database,
                ownerId,
                operations,
                now,
              );
              const applied = intake.apply(
                ownerId,
                parsed.partition,
                operations,
                ownerId,
                now,
              );
              reflectRunnerWorkspaceOperations(
                database,
                ownerId,
                applied.projection,
                now,
              );
              return applied;
            });
      return Response.json({
        frontier: prepareSynchronizationFrontier(result.frontier),
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
