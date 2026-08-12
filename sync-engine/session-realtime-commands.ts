import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  readSessionForkInput,
  type SessionForkInput,
} from "../shared/session-fork.ts";
import {
  readSessionHistoryRequest,
  type SessionHistoryPage,
} from "../shared/session-history.ts";
import type {
  AgentSessionDetail,
  AgentSessionPendingInput,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  readSessionProviderUpdateInput,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import {
  readSessionToolUpdateInput,
  readSessionToolUpdatePreviewInput,
  type SessionToolUpdateInput,
  type SessionToolUpdatePreview,
  type SessionToolUpdatePreviewInput,
} from "../shared/session-tool-update.ts";
import {
  SESSION_REALTIME_OPERATIONS,
  type UserRealtimeCommand,
} from "../shared/user-realtime-protocol.ts";
import { RealtimeCommandFailure } from "./realtime-command-ledger.ts";
import { requiredRealtimeInput } from "./realtime-required-input.ts";
import type {
  AuthenticatedSessionAction,
  SessionDetailReader,
} from "./session-command-types.ts";
import {
  readCreateSession,
  readPrompt,
  readProvider,
  readUserSpawnSession,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import {
  readSessionPendingInputCommand,
  type SessionPendingInputCommand,
} from "./session-pending-input-request.ts";
import { readSessionReassignment } from "./session-reassignment.ts";
import { readIdentifier } from "./session-request-helpers.ts";
import { readSessionStopCascade } from "./session-stop-input.ts";

export type SessionQuestionAnswerAction = (
  user: AuthenticatedUser,
  payload: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
export type SessionCancelPendingInputAction = (
  user: AuthenticatedUser,
  sessionId: string,
  inputId: string,
  workspaceId: string,
) => {
  readonly detail: AgentSessionDetail;
  readonly input: AgentSessionPendingInput;
};
export type SessionCreateAction = (
  user: AuthenticatedUser,
  input: CreateSessionInput,
  workspaceId: string,
) => Promise<AgentSessionDetail>;
export type SessionHistoryAction = (
  user: AuthenticatedUser,
  sessionId: string,
  cursor: string | null,
  workspaceId: string,
) => SessionHistoryPage | undefined;
export type SessionReassignmentAction = (
  user: AuthenticatedUser,
  sessionId: string,
  runnerId: string,
  workingDirectory: string,
  workspaceId: string,
) => AgentSessionDetail;
export type SessionAutoCompactionAction = (
  user: AuthenticatedUser,
  sessionId: string,
  autoCompact: boolean,
  workspaceId: string,
) => AgentSessionDetail;

export type SessionContextTokenCapAction = (
  user: AuthenticatedUser,
  sessionId: string,
  userContextTokenCap: number | null,
  workspaceId: string,
) => AgentSessionDetail;

export type SessionStopAction = (
  user: AuthenticatedUser,
  sessionId: string,
  cascade: boolean,
  workspaceId: string,
) => Promise<AgentSessionDetail> | AgentSessionDetail;

export interface SessionRealtimeCommands extends SessionDetailReader {
  readonly answerQuestionsForUser: SessionQuestionAnswerAction;
  readonly cancelPendingInputForUser: SessionCancelPendingInputAction;
  compactForUser: AuthenticatedSessionAction;
  compactAndContinueForUser: AuthenticatedSessionAction;
  continueForUser: AuthenticatedSessionAction;
  readonly createForUser: SessionCreateAction;
  readonly spawnForUser: (
    user: AuthenticatedUser,
    input: CreateSessionInput & {
      readonly parentGeneration: number;
      readonly parentSessionId: string;
    },
    workspaceId: string,
  ) => Promise<AgentSessionDetail>;
  readonly forkForUser: (
    user: AuthenticatedUser,
    input: SessionForkInput,
    workspaceId: string,
  ) => Promise<AgentSessionDetail>;
  readonly historyForUser: SessionHistoryAction;
  readonly messageForUser: (
    user: AuthenticatedUser,
    sessionId: string,
    input: PromptInput,
    workspaceId: string,
  ) => Promise<AgentSessionDetail>;
  readonly reassignForUser: SessionReassignmentAction;
  updateProviderForUser(
    user: AuthenticatedUser,
    input: SessionProviderUpdateInput,
  ): Promise<AgentSessionDetail>;
  previewToolUpdateForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdatePreviewInput,
  ): Promise<SessionToolUpdatePreview>;
  modelsForUser(
    selection: Readonly<{
      credentialId: string;
      provider: ProviderId;
      user: AuthenticatedUser;
      workspaceId: string;
    }>,
  ): Promise<AgentModelCatalog>;
  pendingInputForUser(
    user: AuthenticatedUser,
    input: SessionPendingInputCommand,
    workspaceId: string,
  ): AgentSessionDetail;
  readonly setAutoCompactionForUser: SessionAutoCompactionAction;
  readonly setIdleCompactionForUser: SessionAutoCompactionAction;
  readonly setContextTokenCapForUser: SessionContextTokenCapAction;
  stopForUser: SessionStopAction;
  summariesForUser(
    userId: string,
    workspaceId: string,
  ): readonly AgentSessionSummary[];
  updateToolsForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdateInput,
  ): Promise<AgentSessionDetail>;
}

function readSessionId(payload: Readonly<Record<string, unknown>>): string {
  return requiredRealtimeInput(readIdentifier(payload["sessionId"]));
}

function readPendingInputId(
  payload: Readonly<Record<string, unknown>>,
): string {
  return requiredRealtimeInput(readIdentifier(payload["inputId"]));
}

function readReassignment(payload: Readonly<Record<string, unknown>>) {
  return requiredRealtimeInput(readSessionReassignment(payload));
}

function readBooleanSetting(
  payload: Readonly<Record<string, unknown>>,
  key: "autoCompact" | "idleCompact",
): boolean {
  const setting = payload[key];
  if (typeof setting !== "boolean") {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return setting;
}

function readContextTokenCap(
  payload: Readonly<Record<string, unknown>>,
): number | null {
  const cap = payload["userContextTokenCap"];
  if (
    cap !== null &&
    (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)
  ) {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return cap;
}

function readCascadeStop(payload: Readonly<Record<string, unknown>>): boolean {
  return requiredRealtimeInput(readSessionStopCascade(payload["cascade"]));
}

function readModelSelection(payload: Readonly<Record<string, unknown>>): {
  readonly credentialId: string;
  readonly provider: ProviderId;
} {
  const credentialId = readIdentifier(payload["credentialId"]);
  const provider = readProvider(payload["provider"]);
  if (credentialId === undefined || provider === undefined) {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return { credentialId, provider };
}

function workspaceSessionInput<Value extends { readonly workspaceId: string }>(
  input: Value | undefined,
  workspaceId: string,
): Value {
  const required = requiredRealtimeInput(input);
  if (required.workspaceId !== workspaceId) {
    throw new RealtimeCommandFailure("not_found");
  }
  return required;
}

function workspaceToolUpdateInput<Value extends SessionToolUpdatePreviewInput>(
  input: Value | undefined,
  workspaceId: string,
): Value {
  return workspaceSessionInput(input, workspaceId);
}

/**
 * Dispatches a command only after the caller has revalidated the WebSocket user.
 * Authentication deliberately remains a transport-boundary responsibility so
 * no connection-time identity can be mistaken for execution-time authority.
 */
export async function executeSessionRealtimeCommand(
  sessions: SessionRealtimeCommands,
  user: AuthenticatedUser,
  command: UserRealtimeCommand,
  workspaceId: string,
): Promise<unknown> {
  const payload = command.payload;

  switch (command.operation) {
    case SESSION_REALTIME_OPERATIONS.answerQuestions:
      if (
        payload["workspaceId"] !== undefined &&
        payload["workspaceId"] !== workspaceId
      ) {
        throw new RealtimeCommandFailure("not_found");
      }
      return sessions.answerQuestionsForUser(user, {
        ...payload,
        workspaceId,
      });
    case SESSION_REALTIME_OPERATIONS.cancelPendingInput:
      return sessions.cancelPendingInputForUser(
        user,
        readSessionId(payload),
        readPendingInputId(payload),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.compact:
      return sessions.compactForUser(user, readSessionId(payload), workspaceId);
    case SESSION_REALTIME_OPERATIONS.compactAndContinue:
      return sessions.compactAndContinueForUser(
        user,
        readSessionId(payload),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.continue:
      return sessions.continueForUser(
        user,
        readSessionId(payload),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.create:
      return sessions.createForUser(
        user,
        requiredRealtimeInput(readCreateSession(payload)),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.spawn:
      return sessions.spawnForUser(
        user,
        requiredRealtimeInput(readUserSpawnSession(payload)),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.followUp:
    case SESSION_REALTIME_OPERATIONS.steer:
      return sessions.pendingInputForUser(
        user,
        requiredRealtimeInput(readSessionPendingInputCommand(payload)),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.fork: {
      const input = workspaceSessionInput(
        readSessionForkInput(payload),
        workspaceId,
      );
      return sessions.forkForUser(user, input, workspaceId);
    }
    case SESSION_REALTIME_OPERATIONS.history: {
      const request = readSessionHistoryRequest(payload);
      if (
        request === undefined ||
        (payload["workspaceId"] !== undefined &&
          payload["workspaceId"] !== workspaceId)
      ) {
        throw new RealtimeCommandFailure("invalid_request");
      }
      const page = sessions.historyForUser(
        user,
        request.sessionId,
        request.cursor,
        workspaceId,
      );
      if (page === undefined) {
        throw new RealtimeCommandFailure("not_found");
      }
      return page;
    }
    case SESSION_REALTIME_OPERATIONS.models: {
      const selection = readModelSelection(payload);
      return sessions.modelsForUser({ ...selection, user, workspaceId });
    }
    case SESSION_REALTIME_OPERATIONS.previewToolUpdate: {
      const input = workspaceToolUpdateInput(
        readSessionToolUpdatePreviewInput(payload),
        workspaceId,
      );
      return sessions.previewToolUpdateForUser(user, input);
    }
    case SESSION_REALTIME_OPERATIONS.read: {
      const detail = sessions.detailForUser(
        user.id,
        readSessionId(payload),
        workspaceId,
      );
      if (detail?.workspaceId !== workspaceId) {
        throw new RealtimeCommandFailure("not_found");
      }
      return detail;
    }
    case SESSION_REALTIME_OPERATIONS.reassign: {
      const { runnerId, workingDirectory } = readReassignment(payload);
      return sessions.reassignForUser(
        user,
        readSessionId(payload),
        runnerId,
        workingDirectory,
        workspaceId,
      );
    }
    case SESSION_REALTIME_OPERATIONS.send:
      return sessions.messageForUser(
        user,
        readSessionId(payload),
        requiredRealtimeInput(readPrompt(payload)),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.setAutoCompaction:
      return sessions.setAutoCompactionForUser(
        user,
        readSessionId(payload),
        readBooleanSetting(payload, "autoCompact"),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.setIdleCompaction:
      return sessions.setIdleCompactionForUser(
        user,
        readSessionId(payload),
        readBooleanSetting(payload, "idleCompact"),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.setContextTokenCap:
      return sessions.setContextTokenCapForUser(
        user,
        readSessionId(payload),
        readContextTokenCap(payload),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.stop:
      return sessions.stopForUser(
        user,
        readSessionId(payload),
        readCascadeStop(payload),
        workspaceId,
      );
    case SESSION_REALTIME_OPERATIONS.subscribe:
      return { sessions: sessions.summariesForUser(user.id, workspaceId) };
    case SESSION_REALTIME_OPERATIONS.updateProvider: {
      const input = workspaceSessionInput(
        readSessionProviderUpdateInput(payload),
        workspaceId,
      );
      return sessions.updateProviderForUser(user, input);
    }
    case SESSION_REALTIME_OPERATIONS.updateTools: {
      const input = workspaceToolUpdateInput(
        readSessionToolUpdateInput(payload),
        workspaceId,
      );
      return sessions.updateToolsForUser(user, input);
    }
    default:
      throw new RealtimeCommandFailure("unsupported_operation");
  }
}
