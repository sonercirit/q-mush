import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  SESSION_REALTIME_OPERATIONS,
  type UserRealtimeCommand,
} from "../shared/user-realtime-protocol.ts";
import { RealtimeCommandFailure } from "./realtime-command-ledger.ts";
import {
  readCreateSession,
  readPrompt,
  readProvider,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import { readIdentifier } from "./session-request-helpers.ts";

export interface SessionRealtimeCommands {
  compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<AgentSessionDetail>;
  continueForUser(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<AgentSessionDetail>;
  createForUser(
    user: AuthenticatedUser,
    input: CreateSessionInput,
  ): Promise<AgentSessionDetail>;
  readForUser(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined;
  summariesForUser(userId: string): readonly AgentSessionSummary[];
  messageForUser(
    ...parameters: [AuthenticatedUser, string, PromptInput]
  ): Promise<AgentSessionDetail>;
  modelsForUser(
    selection: Readonly<{
      credentialId: string;
      provider: ProviderId;
      user: AuthenticatedUser;
    }>,
  ): Promise<AgentModelCatalog>;
  setAutoCompactionForUser(
    user: AuthenticatedUser,
    sessionId: string,
    autoCompact: boolean,
  ): AgentSessionDetail;
  stopForUser(user: AuthenticatedUser, sessionId: string): AgentSessionDetail;
}

function sessionId(payload: Readonly<Record<string, unknown>>): string {
  const parsed = readIdentifier(payload["sessionId"]);
  if (parsed === undefined) {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return parsed;
}

function readAutoCompaction(
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const autoCompact = payload["autoCompact"];
  if (typeof autoCompact !== "boolean") {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return autoCompact;
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

function requiredInput<Input>(input: Input | undefined): Input {
  if (input === undefined) {
    throw new RealtimeCommandFailure("invalid_request");
  }
  return input;
}

export async function executeSessionRealtimeCommand(
  sessions: SessionRealtimeCommands,
  user: AuthenticatedUser,
  command: UserRealtimeCommand,
): Promise<unknown> {
  const payload = command.payload;
  switch (command.operation) {
    case SESSION_REALTIME_OPERATIONS.subscribe:
      return { sessions: sessions.summariesForUser(user.id) };
    case SESSION_REALTIME_OPERATIONS.read: {
      const detail = sessions.readForUser(user.id, sessionId(payload));
      if (detail === undefined) {
        throw new RealtimeCommandFailure("not_found");
      }
      return { session: detail };
    }
    case SESSION_REALTIME_OPERATIONS.create:
      return sessions.createForUser(
        user,
        requiredInput(readCreateSession(payload)),
      );
    case SESSION_REALTIME_OPERATIONS.send:
      return sessions.messageForUser(
        user,
        sessionId(payload),
        requiredInput(readPrompt(payload)),
      );
    case SESSION_REALTIME_OPERATIONS.continue:
      return sessions.continueForUser(user, sessionId(payload));
    case SESSION_REALTIME_OPERATIONS.stop:
      return sessions.stopForUser(user, sessionId(payload));
    case SESSION_REALTIME_OPERATIONS.compact:
      return sessions.compactForUser(user, sessionId(payload));
    case SESSION_REALTIME_OPERATIONS.setAutoCompaction:
      return sessions.setAutoCompactionForUser(
        user,
        sessionId(payload),
        readAutoCompaction(payload),
      );
    case SESSION_REALTIME_OPERATIONS.models: {
      const selection = readModelSelection(payload);
      return sessions.modelsForUser({
        credentialId: selection.credentialId,
        provider: selection.provider,
        user,
      });
    }
    default:
      if (!command.operation.startsWith("sessions.") || !isRecord(payload)) {
        throw new RealtimeCommandFailure("unsupported_operation");
      }
      throw new RealtimeCommandFailure("unsupported_operation");
  }
}
