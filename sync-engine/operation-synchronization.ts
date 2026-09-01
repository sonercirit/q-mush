import type { AppDatabase } from "../shared/database";
import { decodeOperationEnvelope } from "../shared/operation-checkpoint";
import {
  isOperationProtocolError,
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_ENVELOPE_BYTES,
  operationProtocolError,
  type OperationPartition,
} from "../shared/operation-core";
import {
  parseSynchronizationFrontier,
  prepareSynchronizationFrontier,
} from "../shared/operation-intake-core";
import type { GoogleAuth } from "./auth";
import { parseRecordJsonForMethod } from "./http";
import {
  createOperationIntake,
  type OperationIntakeLimits,
} from "./operation-intake";
import { createOperationStore } from "./operation-store";

const MAX_ENVELOPE_PAGE_SIZE = 256;
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
    !envelopes.every(
      (value) =>
        typeof value === "string" &&
        new TextEncoder().encode(value).byteLength <=
          MAX_OPERATION_ENVELOPE_BYTES,
    )
  )
    return undefined;
  return { ...scope, envelopes };
};

export const createOperationSynchronization = (
  database: AppDatabase,
  googleAuth: Pick<GoogleAuth, "authenticatedUser">,
  limits?: OperationIntakeLimits,
  runnerAuth?: {
    readonly runnerAccount: (
      request: Request,
    ) => { readonly userId: string } | undefined;
  },
) => {
  const intake = createOperationIntake(
    limits === undefined ? { database } : { database, limits },
  );
  const store = createOperationStore({ database });
  return async (request: Request): Promise<Response> => {
    const browserUser = googleAuth.authenticatedUser(request);
    const runnerUser = runnerAuth?.runnerAccount(request);
    if (browserUser === null && runnerUser === undefined)
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
    if (parsed === undefined)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    // Runner credentials deliberately take precedence when both auth mechanisms
    // are present, so runner owner alias semantics cannot become browser scope.
    const ownerId =
      runnerUser === undefined ? browserUser?.id : runnerUser.userId;
    const ownsScope =
      runnerUser === undefined
        ? parsed.ownerId === ownerId
        : parsed.ownerId === "self";
    if (ownerId === undefined || !ownsScope)
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
            operation.writerId !== ownerId,
        )
      )
        return new Response("Forbidden", { status: 403 });
      const result = intake.apply(
        ownerId,
        parsed.partition,
        operations,
        ownerId,
        now,
      );
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

export const createRunnerOperationSynchronization = (
  database: AppDatabase,
  googleAuth: Pick<GoogleAuth, "authenticatedUser">,
  runnerAuth: NonNullable<Parameters<typeof createOperationSynchronization>[3]>,
) =>
  createOperationSynchronization(database, googleAuth, undefined, runnerAuth);
