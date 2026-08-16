export const DEVELOPMENT_RESTART_REQUEST_MESSAGE =
  "q-mush:development-restart-request";
export const DEVELOPMENT_RESTART_ESCALATE_MESSAGE =
  "q-mush:development-restart-escalate";
export const DEVELOPMENT_RESTART_READY_MESSAGE =
  "q-mush:development-restart-ready";
export const DEVELOPMENT_RESTART_PROGRESS_MESSAGE =
  "q-mush:development-restart-progress";
export const FINAL_SHUTDOWN_REQUEST_MESSAGE = "q-mush:final-shutdown-request";
export const FINAL_SHUTDOWN_PREPARED_MESSAGE = "q-mush:final-shutdown-prepared";

export interface DevelopmentRestartProgress {
  readonly elapsedMs: number;
  readonly runnerId: string;
  readonly sessionId: string;
  readonly tools: readonly string[];
}

export interface DevelopmentRestartProgressMessage {
  readonly progress: readonly DevelopmentRestartProgress[];
  readonly type: typeof DEVELOPMENT_RESTART_PROGRESS_MESSAGE;
}

function restartProgressEntry(
  value: unknown,
): DevelopmentRestartProgress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const elapsedMs = "elapsedMs" in value ? value.elapsedMs : undefined;
  const runnerId = "runnerId" in value ? value.runnerId : undefined;
  const sessionId = "sessionId" in value ? value.sessionId : undefined;
  const tools = "tools" in value ? value.tools : undefined;
  return typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    typeof runnerId === "string" &&
    typeof sessionId === "string" &&
    Array.isArray(tools) &&
    tools.length <= 100 &&
    tools.every(
      (tool: unknown) => typeof tool === "string" && tool.length <= 200,
    )
    ? { elapsedMs, runnerId, sessionId, tools }
    : undefined;
}

export function readDevelopmentRestartProgress(
  value: unknown,
): readonly DevelopmentRestartProgress[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const progress = value.map(restartProgressEntry);
  return progress.every((entry) => entry !== undefined) ? progress : undefined;
}

export function isDevelopmentRestartProgressMessage(
  value: unknown,
): value is DevelopmentRestartProgressMessage {
  if (typeof value !== "object" || value === null) return false;
  const progress = "progress" in value ? value.progress : undefined;
  return (
    "type" in value &&
    value.type === DEVELOPMENT_RESTART_PROGRESS_MESSAGE &&
    readDevelopmentRestartProgress(progress) !== undefined
  );
}

// A restart drain waits for in-flight steps, and a step owns its tool calls,
// so a validation battery legitimately holds one for minutes. The development
// supervisor asks the engine to drain over IPC and may explicitly escalate a
// repeated request. The engine bounds the complete live restart lifecycle —
// runtime settlement and best-effort execution cleanup — to this deadline.
// Final shutdown uses a distinct IPC request and remains intentionally
// unbounded after its durable interrupted markers are prepared.
export const RESTART_DRAIN_LIMIT_MS = 120_000;
export const RESTART_CLEANUP_LIMIT_MS = 5_000;
export const RESTART_PROGRESS_INTERVAL_MS = 5_000;
