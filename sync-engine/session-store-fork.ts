import { compareAgentSessionMessages } from "../shared/session-message-order.ts";
import {
  forkStoredSession,
  type ForkAgentSession,
  type ForkSessionResult,
} from "./session-store-create.ts";
import { readInternalSessionMessages } from "./session-store-read.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";

export type SessionStoreForkParameters = readonly [
  userId: string,
  sourceSessionId: string,
  forkPointMessageId: string,
  workspaceId: string,
  now: number,
  configuration?: ForkAgentSession["configuration"],
];

export type SessionStoreForkResult =
  ForkSessionResult | { readonly status: "fork_point_not_found" | "not_found" };

function forkConfigurationPreservesReplay(
  source: Readonly<{
    credentialId: string;
    model: string;
    provider: string;
  }>,
  configuration: ForkAgentSession["configuration"],
): boolean {
  return (
    configuration === undefined ||
    (configuration.credentialId === source.credentialId &&
      configuration.model === source.model &&
      configuration.provider === source.provider)
  );
}

export function forkStoredSessionFromSource(
  resources: SessionStoreWriteResources,
  ...[
    userId,
    sourceSessionId,
    forkPointMessageId,
    workspaceId,
    now,
    configuration,
  ]: SessionStoreForkParameters
): SessionStoreForkResult {
  const source = resources.read(userId, sourceSessionId, workspaceId);
  if (source === undefined) {
    return { status: "not_found" };
  }
  const messages = readInternalSessionMessages(resources.database, source.id);
  const forkPoint = messages.find(
    ({ message }) => message.id === forkPointMessageId,
  );
  if (forkPoint === undefined) {
    return { status: "fork_point_not_found" };
  }
  const preserveReplay = forkConfigurationPreservesReplay(
    source,
    configuration,
  );
  const copied = messages
    .filter(
      ({ message }) =>
        compareAgentSessionMessages(message, forkPoint.message) <= 0 &&
        (message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool"),
    )
    .map((internal) =>
      internal.providerReplay === undefined || preserveReplay
        ? internal
        : { message: internal.message },
    );
  return forkStoredSession(
    resources,
    {
      autoCompact: source.autoCompact,
      idleCompact: source.idleCompact,
      ...(configuration === undefined ? {} : { configuration }),
      messages: copied,
      source,
      userId,
      workspaceId,
    },
    now,
  );
}
