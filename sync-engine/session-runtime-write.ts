import type {
  AgentSessionDetail,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import type { SessionStore } from "./session-store.ts";

export type SessionRuntimeApply = (
  sessionId: string,
  now: number,
  generation: number,
) => void;

export type SessionRuntimeWriter = (apply: SessionRuntimeApply) => void;

export function invokeRuntimeWrite(
  now: () => number,
  generation: number,
  action: (timestamp: number, generation: number) => void,
  notify: () => void,
): void {
  action(now(), generation);
  notify();
}

export interface SessionRuntimeSource {
  readonly detail: Pick<AgentSessionDetail, "generation" | "id">;
  readonly notify: () => void;
  readonly now: () => number;
}

export function writeSessionRuntime(
  runtime: SessionRuntimeSource,
  write: SessionRuntimeApply,
): void {
  write(runtime.detail.id, runtime.now(), runtime.detail.generation);
  runtime.notify();
}

export function recordSessionRuntimeUsage(
  runtime: SessionRuntimeSource & {
    readonly store: Pick<SessionStore, "updateRuntimeUsage">;
  },
  usage: AgentSessionUsageUpdate,
): void {
  writeSessionRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.updateRuntimeUsage(sessionId, usage, now, generation);
  });
}
