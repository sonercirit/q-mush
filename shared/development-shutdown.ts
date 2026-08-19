import type { RestartProgressEntry } from "./restart-progress.ts";

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

export interface DevelopmentRestartRequestMessage {
  readonly deadlineAt: number;
  readonly type: typeof DEVELOPMENT_RESTART_REQUEST_MESSAGE;
}

export function isDevelopmentRestartRequestMessage(
  value: unknown,
): value is DevelopmentRestartRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const deadlineAt = "deadlineAt" in value ? value.deadlineAt : undefined;
  return (
    "type" in value &&
    value.type === DEVELOPMENT_RESTART_REQUEST_MESSAGE &&
    typeof deadlineAt === "number" &&
    Number.isFinite(deadlineAt)
  );
}

export interface DevelopmentRestartProgress extends RestartProgressEntry {
  readonly runnerId: string;
}

export interface DevelopmentRestartProgressMessage {
  readonly progress: readonly DevelopmentRestartProgress[];
  readonly type: typeof DEVELOPMENT_RESTART_PROGRESS_MESSAGE;
}

function restartProgressTool(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const count = "count" in value ? value.count : undefined;
  const name = "name" in value ? value.name : undefined;
  return typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200
    ? { count, name }
    : undefined;
}

function restartProgressEntry(
  value: unknown,
): DevelopmentRestartProgress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const elapsedMs = "elapsedMs" in value ? value.elapsedMs : undefined;
  const runnerId = "runnerId" in value ? value.runnerId : undefined;
  const sessionId = "sessionId" in value ? value.sessionId : undefined;
  const tools = "tools" in value ? value.tools : undefined;
  const totalTools = "totalTools" in value ? value.totalTools : undefined;
  const parsedTools = Array.isArray(tools)
    ? tools.map(restartProgressTool)
    : undefined;
  return typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    typeof runnerId === "string" &&
    typeof sessionId === "string" &&
    Array.isArray(parsedTools) &&
    parsedTools.length <= 100 &&
    parsedTools.every((tool) => tool !== undefined) &&
    typeof totalTools === "number" &&
    Number.isSafeInteger(totalTools) &&
    totalTools >= parsedTools.reduce((total, tool) => total + tool.count, 0)
    ? {
        elapsedMs,
        runnerId,
        sessionId,
        tools: parsedTools,
        totalTools,
      }
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

// A drain can legitimately wait on a long in-flight validation step. The
// supervisor owns this absolute deadline across persistence, runtime draining,
// cleanup, and child termination; repeated requests escalate immediately.
// Final shutdown is a separate unbounded lifecycle after durable preparation.
export const DEVELOPMENT_RESTART_LIFECYCLE_MS = 120_000;
export const DEVELOPMENT_RESTART_FORCE_KILL_MS = 1_000;
export const RESTART_PROGRESS_INTERVAL_MS = 5_000;
