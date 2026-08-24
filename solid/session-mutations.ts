import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { isHttpResponseError } from "./browser-http.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import type { SessionMutationAcknowledgement } from "./session-mutation-acknowledgement.ts";
import { validOptionalImagePayload } from "./session-payload.ts";
import { withPendingCommandCapacity } from "./session-pending.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

type SessionPendingAction =
  "compacting" | "reassigning" | "sending" | "stopping";

type SessionMutationOperation = Exclude<
  (typeof SESSION_REALTIME_OPERATIONS)[keyof typeof SESSION_REALTIME_OPERATIONS],
  | typeof SESSION_REALTIME_OPERATIONS.answerQuestions
  | typeof SESSION_REALTIME_OPERATIONS.cancelPendingInput
  | typeof SESSION_REALTIME_OPERATIONS.create
  | typeof SESSION_REALTIME_OPERATIONS.fork
  | typeof SESSION_REALTIME_OPERATIONS.history
  | typeof SESSION_REALTIME_OPERATIONS.models
  | typeof SESSION_REALTIME_OPERATIONS.previewToolUpdate
  | typeof SESSION_REALTIME_OPERATIONS.read
  | typeof SESSION_REALTIME_OPERATIONS.spawn
  | typeof SESSION_REALTIME_OPERATIONS.subscribe
  | typeof SESSION_REALTIME_OPERATIONS.updateTools
>;

const UNKNOWN_OUTCOME_CODES = new Set([
  "command_outcome_unknown",
  "outcome_unknown",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error === "string") {
    return UNKNOWN_OUTCOME_CODES.has(error) ? "outcome_unknown" : error;
  }
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  if (
    (typeof code === "string" && UNKNOWN_OUTCOME_CODES.has(code)) ||
    (typeof message === "string" && UNKNOWN_OUTCOME_CODES.has(message))
  ) {
    return "outcome_unknown";
  }
  return typeof code === "string" ? code : message;
}

export interface SessionMutation {
  readonly action: string;
  readonly operation: SessionMutationOperation;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly pending: SessionPendingAction;
}

export function compactSessionMutation(
  sessionId: string,
  continueAfter = false,
): SessionMutation {
  return sessionMutation(
    sessionId,
    continueAfter
      ? SESSION_REALTIME_OPERATIONS.compactAndContinue
      : SESSION_REALTIME_OPERATIONS.compact,
    "compact that session",
    "compacting",
  );
}

export function continueSessionMutation(sessionId: string): SessionMutation {
  return sessionMutation(
    sessionId,
    SESSION_REALTIME_OPERATIONS.continue,
    "continue that session",
    "sending",
  );
}

export function sendSessionMutation(
  sessionId: string,
  prompt: string,
  images: SessionViewState["followUpImages"],
): SessionMutation {
  return {
    action: "send that instruction",
    operation: SESSION_REALTIME_OPERATIONS.send,
    payload: {
      ...(images.length === 0 ? {} : { images }),
      prompt,
      sessionId,
    },
    pending: "sending",
  };
}

export function reassignSessionMutation(
  sessionId: string,
  runnerId: string,
  workingDirectory: string,
): SessionMutation {
  return {
    action: "reassign that session",
    operation: SESSION_REALTIME_OPERATIONS.reassign,
    payload: { runnerId, sessionId, workingDirectory },
    pending: "reassigning",
  };
}

export function stopSessionMutation(
  sessionId: string,
  cascade?: boolean,
): SessionMutation {
  const mutation = sessionMutation(
    sessionId,
    SESSION_REALTIME_OPERATIONS.stop,
    "stop that session",
    "stopping",
  );
  return cascade === undefined
    ? mutation
    : { ...mutation, payload: { cascade, sessionId } };
}

export function contextTokenCapMutation(
  sessionId: string,
  userContextTokenCap: number | null,
): SessionMutation {
  return {
    action: "change the context token cap",
    operation: SESSION_REALTIME_OPERATIONS.setContextTokenCap,
    payload: { sessionId, userContextTokenCap },
    pending: "compacting",
  };
}

export function compactionModeMutation(
  sessionId: string,
  autoCompact: boolean,
): SessionMutation {
  return {
    action: "change compaction mode",
    operation: SESSION_REALTIME_OPERATIONS.setAutoCompaction,
    payload: { autoCompact, sessionId },
    pending: "compacting",
  };
}

export function idleCompactionModeMutation(
  sessionId: string,
  idleCompact: boolean,
): SessionMutation {
  return {
    action: "change idle compaction",
    operation: SESSION_REALTIME_OPERATIONS.setIdleCompaction,
    payload: { idleCompact, sessionId },
    pending: "compacting",
  };
}

function sessionMutation(
  sessionId: string,
  operation: SessionMutation["operation"],
  action: string,
  pending: SessionPendingAction,
): SessionMutation {
  return { action, operation, payload: { sessionId }, pending };
}

type SessionLaunchMutationOperation =
  | typeof SESSION_REALTIME_OPERATIONS.compact
  | typeof SESSION_REALTIME_OPERATIONS.compactAndContinue
  | typeof SESSION_REALTIME_OPERATIONS.continue;

function launchMutation(
  operation: SessionMutation["operation"],
): operation is SessionLaunchMutationOperation {
  return (
    operation === SESSION_REALTIME_OPERATIONS.compact ||
    operation === SESSION_REALTIME_OPERATIONS.compactAndContinue ||
    operation === SESSION_REALTIME_OPERATIONS.continue
  );
}

function payloadHasKeyCount(
  payload: Readonly<Record<string, unknown>>,
  count: number,
): boolean {
  return Object.keys(payload).length === count;
}

function pendingInputMatches(
  detail: AgentSessionDetail,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  return detail.pendingInputs.some(
    ({ clientRequestId }) => clientRequestId === payload["clientRequestId"],
  );
}

function settingMatches(
  detailValue: boolean | number | null,
  payload: Readonly<Record<string, unknown>>,
  payloadKey: "autoCompact" | "idleCompact" | "userContextTokenCap",
): boolean {
  return detailValue === payload[payloadKey];
}

function runMutationHandler(
  operation: SessionMutationOperation,
  handlers: Record<SessionMutationOperation, () => boolean>,
): boolean {
  return handlers[operation]();
}

function validSessionMutationPayload(mutation: SessionMutation): boolean {
  const payload = mutation.payload;
  const followUp = (): boolean =>
    validOptionalImagePayload(payload, 4) &&
    typeof payload["clientRequestId"] === "string" &&
    typeof payload["prompt"] === "string" &&
    (payload["kind"] === "follow_up" || payload["kind"] === "steer");
  return runMutationHandler(mutation.operation, {
    [SESSION_REALTIME_OPERATIONS.compact]: () => payloadHasKeyCount(payload, 1),
    [SESSION_REALTIME_OPERATIONS.compactAndContinue]: () =>
      payloadHasKeyCount(payload, 1),
    [SESSION_REALTIME_OPERATIONS.continue]: () => payloadHasKeyCount(payload, 1),
    [SESSION_REALTIME_OPERATIONS.followUp]: followUp,
    [SESSION_REALTIME_OPERATIONS.reassign]: () =>
      Object.keys(payload).length === 3 &&
      typeof payload["runnerId"] === "string" &&
      typeof payload["workingDirectory"] === "string",
    [SESSION_REALTIME_OPERATIONS.send]: () =>
      validOptionalImagePayload(payload, 2) &&
      typeof payload["prompt"] === "string",
    [SESSION_REALTIME_OPERATIONS.setAutoCompaction]: () =>
      Object.keys(payload).length === 2 &&
      typeof payload["autoCompact"] === "boolean",
    [SESSION_REALTIME_OPERATIONS.setContextTokenCap]: () =>
      Object.keys(payload).length === 2 &&
      (payload["userContextTokenCap"] === null ||
        (typeof payload["userContextTokenCap"] === "number" &&
          Number.isSafeInteger(payload["userContextTokenCap"]) &&
          payload["userContextTokenCap"] > 0)),
    [SESSION_REALTIME_OPERATIONS.setIdleCompaction]: () =>
      Object.keys(payload).length === 2 &&
      typeof payload["idleCompact"] === "boolean",
    [SESSION_REALTIME_OPERATIONS.steer]: followUp,
    [SESSION_REALTIME_OPERATIONS.stop]: () =>
      Object.keys(payload).length ===
        (payload["cascade"] === undefined ? 1 : 2) &&
      (payload["cascade"] === undefined ||
        typeof payload["cascade"] === "boolean"),
    [SESSION_REALTIME_OPERATIONS.updateProvider]: () => false,
  });
}

export function sessionMutationOutcomeIsUnknown(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && UNKNOWN_OUTCOME_CODES.has(code);
}

export function normalizedSessionMutationError(error: unknown): unknown {
  return sessionMutationOutcomeIsUnknown(error)
    ? Object.assign(new Error("outcome_unknown"), { code: "outcome_unknown" })
    : error;
}

function serializedValuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface SessionSnapshotIdentity {
  readonly generation: number;
  readonly id: string;
  readonly updatedAt: number;
}

export function sessionSnapshotIsAtLeast(
  candidate: SessionSnapshotIdentity,
  reference: SessionSnapshotIdentity,
): boolean {
  return (
    candidate.id === reference.id &&
    (candidate.generation > reference.generation ||
      (candidate.generation === reference.generation &&
        candidate.updatedAt >= reference.updatedAt))
  );
}

function mutationIsReconciled(
  mutation: SessionMutation,
  baseline: AgentSessionDetail,
  detail: AgentSessionDetail,
): boolean {
  if (
    detail.id !== baseline.id ||
    !sessionSnapshotIsAtLeast(detail, baseline) ||
    mutation.payload["sessionId"] !== baseline.id ||
    !validSessionMutationPayload(mutation)
  ) {
    return false;
  }
  const generationAdvanced = detail.generation > baseline.generation;
  if (launchMutation(mutation.operation)) {
    return generationAdvanced;
  }
  return runMutationHandler(mutation.operation, {
    [SESSION_REALTIME_OPERATIONS.compact]: () => generationAdvanced,
    [SESSION_REALTIME_OPERATIONS.compactAndContinue]: () => generationAdvanced,
    [SESSION_REALTIME_OPERATIONS.continue]: () => generationAdvanced,
    [SESSION_REALTIME_OPERATIONS.followUp]: () =>
      pendingInputMatches(detail, mutation.payload),
    [SESSION_REALTIME_OPERATIONS.reassign]: () =>
      generationAdvanced &&
      detail.runnerId === mutation.payload["runnerId"] &&
      detail.workingDirectory === mutation.payload["workingDirectory"] &&
      !detail.runnerRequired,
    [SESSION_REALTIME_OPERATIONS.send]: () => {
      const prompt = mutation.payload["prompt"];
      const images = mutation.payload["images"] ?? [];
      const previousMessageIds = new Set(baseline.messages.map(({ id }) => id));
      return (
        generationAdvanced &&
        typeof prompt === "string" &&
        Array.isArray(images) &&
        detail.messages.some(
          (message) =>
            !previousMessageIds.has(message.id) &&
            message.role === "user" &&
            message.content === prompt &&
            serializedValuesMatch(message.images, images),
        )
      );
    },
    [SESSION_REALTIME_OPERATIONS.setAutoCompaction]: () =>
      settingMatches(detail.autoCompact, mutation.payload, "autoCompact"),
    [SESSION_REALTIME_OPERATIONS.setContextTokenCap]: () =>
      settingMatches(
        detail.userContextTokenCap,
        mutation.payload,
        "userContextTokenCap",
      ),
    [SESSION_REALTIME_OPERATIONS.setIdleCompaction]: () =>
      settingMatches(detail.idleCompact, mutation.payload, "idleCompact"),
    [SESSION_REALTIME_OPERATIONS.steer]: () =>
      pendingInputMatches(detail, mutation.payload),
    [SESSION_REALTIME_OPERATIONS.stop]: () => detail.status === "stopped",
    [SESSION_REALTIME_OPERATIONS.updateProvider]: () => false,
  });
}

export function acknowledgeSessionMutation(
  current: AgentSessionDetail | undefined,
  acknowledgement: AgentSessionDetail,
  mutation: SessionMutation,
  baseline: AgentSessionDetail,
): SessionMutationAcknowledgement {
  if (!mutationIsReconciled(mutation, baseline, acknowledgement)) {
    return { status: "uncertain" };
  }
  return {
    detail:
      current !== undefined &&
      sessionSnapshotIsAtLeast(current, acknowledgement)
        ? current
        : acknowledgement,
    status: "committed",
  };
}

export async function executeSessionMutation(
  transport: SessionCommandTransport,
  mutation: SessionMutation,
  userId = "browser",
): Promise<AgentSessionDetail> {
  return readSessionDetail(
    await withPendingCommandCapacity(userId, mutation.payload, () =>
      transport.command(mutation.operation, mutation.payload),
    ),
  );
}

export function sessionMutationError(error: unknown, action: string): string {
  const code = errorCode(error);
  if (code === "invalid_context_token_cap") {
    return error instanceof Error && error.message !== code
      ? error.message
      : "The context token cap is invalid. Refresh the session and try again.";
  }
  if (code === "command_capacity_exceeded") {
    return (
      `The browser has too much pending session data to ${action}. ` +
      "Wait for current requests to finish, then try again."
    );
  }
  if (
    (isHttpResponseError(error) && error.status === 409) ||
    (code !== undefined &&
      [
        "request_conflict",
        "runner_unavailable",
        "session_busy",
        "session_not_required",
      ].includes(code))
  ) {
    return "The selected runner or credential is unavailable, or the session is busy.";
  }

  if (sessionMutationOutcomeIsUnknown(error)) {
    return (
      `We could not confirm whether the server completed the request to ${action}. ` +
      "Refreshing session state is required before trying again."
    );
  }

  return `We could not ${action}. Please try again.`;
}
