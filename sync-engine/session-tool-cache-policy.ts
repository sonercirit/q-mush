import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  SESSION_TOOL_CACHE_WARNING,
  sessionToolsMatch,
  type SessionToolUpdatePreview,
} from "../shared/session-tool-update.ts";
import {
  sessionToolCacheCapability,
  type SessionToolCacheCapabilityInput,
} from "./session-tool-capability.ts";

export function sessionToolCachePreview(
  session: Pick<AgentSessionDetail, "generation" | "tools">,
  tools: readonly AgentSessionToolName[],
  capabilityInput: SessionToolCacheCapabilityInput,
): SessionToolUpdatePreview {
  const unchanged = sessionToolsMatch(session.tools, tools);
  const nextCapability = sessionToolCacheCapability({
    ...capabilityInput,
    tools,
  });
  const currentCapability = sessionToolCacheCapability({
    ...capabilityInput,
    tools: session.tools,
  });
  const preserved =
    unchanged ||
    (currentCapability.preservesDynamicToolCache &&
      nextCapability.preservesDynamicToolCache);
  return {
    cacheDisposition: preserved ? "preserved" : "warning_required",
    currentGeneration: session.generation,
    tools,
    warning: preserved ? null : SESSION_TOOL_CACHE_WARNING,
  };
}
