import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { SessionToolUpdatePreview } from "../shared/session-tool-update.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { readSessionDetail } from "./session-codec.ts";
import type {
  SessionCommandViewOptions,
  SessionToolUpdateResult,
} from "./session-controller-options.ts";
import type { SessionRealtimeState } from "./session-controller-state.ts";
import { sessionMutationError } from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";

function readPreview(value: unknown): SessionToolUpdatePreview {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid tool update preview");
  }
  const cacheDisposition = value["cacheDisposition"];
  const currentGeneration = value["currentGeneration"];
  const tools = readAgentSessionToolNames(value["tools"]);
  const warning = value["warning"];
  if (
    (cacheDisposition !== "preserved" &&
      cacheDisposition !== "warning_required") ||
    typeof currentGeneration !== "number" ||
    !Number.isSafeInteger(currentGeneration) ||
    currentGeneration < 0 ||
    tools === undefined ||
    (warning !== null && typeof warning !== "string")
  ) {
    throw new Error("The server returned an invalid tool update preview");
  }
  return { cacheDisposition, currentGeneration, tools, warning };
}

export async function updateSessionTools(
  options: SessionCommandViewOptions & {
    readonly confirmedCacheDrop: boolean;
    readonly realtime: SessionRealtimeState;
    readonly tools: readonly AgentSessionToolName[];
  },
): Promise<SessionToolUpdateResult> {
  const detail = options.view.value.detail;
  if (
    detail === undefined ||
    options.transport === undefined ||
    sessionMutationPending(options.view.value) ||
    options.view.value.updatingTools
  ) {
    return { warning: null, updated: false };
  }
  const revision = options.view.begin({
    error: undefined,
    toolUpdateWarning: null,
    updatingTools: true,
  });
  options.realtime.rebaseStream(detail.id);
  try {
    const preview = readPreview(
      await options.transport.command(
        SESSION_REALTIME_OPERATIONS.previewToolUpdate,
        {
          sessionId: detail.id,
          tools: options.tools,
          workspaceId: detail.workspaceId,
        },
      ),
    );
    if (
      preview.cacheDisposition === "warning_required" &&
      !options.confirmedCacheDrop
    ) {
      options.view.patchCurrent(revision, {
        toolUpdateWarning: preview.warning,
        updatingTools: false,
      });
      return { warning: preview.warning, updated: false };
    }
    const updated = readSessionDetail(
      await options.transport.command(SESSION_REALTIME_OPERATIONS.updateTools, {
        confirmedCacheDrop: options.confirmedCacheDrop,
        expectedGeneration: preview.currentGeneration,
        sessionId: detail.id,
        tools: options.tools,
        workspaceId: detail.workspaceId,
      }),
    );
    if (
      options.view.patchCurrent(revision, {
        toolUpdateWarning: null,
        updatingTools: false,
      })
    ) {
      options.realtime.applyDetail(updated);
    }
    return { warning: null, updated: true };
  } catch (error) {
    options.view.patchCurrent(revision, {
      error: sessionMutationError(error, "change session tool access"),
      updatingTools: false,
    });
    return { warning: null, updated: false };
  }
}
