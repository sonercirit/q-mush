import type { AgentFile } from "../shared/agent-file.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export interface SessionModelContextOptions {
  readonly agentFile: AgentFile | null;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly isCurrent: () => boolean;
  readonly realtime: RealtimeHub | undefined;
  readonly streamId?: string;
  readonly toolStream?: ToolStreamPublisher;
  readonly userId: string;
}

export function sessionModelContextOptions(
  options: SessionModelContextOptions,
): SessionModelContextOptions {
  const stream =
    options.streamId === undefined ? {} : { streamId: options.streamId };
  const tool =
    options.toolStream === undefined ? {} : { toolStream: options.toolStream };
  return {
    agentFile: options.agentFile,
    credential: options.credential,
    detail: options.detail,
    isCurrent: options.isCurrent,
    realtime: options.realtime,
    ...stream,
    ...tool,
    userId: options.userId,
  };
}
