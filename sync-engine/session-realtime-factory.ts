import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionQueueDependencies } from "./session-queue.ts";
import {
  RealtimeSessionCommands,
  type RealtimeSessionCommandsOptions,
} from "./session-realtime-integration.ts";

export type CreateRealtimeSessionCommandsOptions = Omit<
  RealtimeSessionCommandsOptions,
  "availability" | "lifecycle"
> &
  Pick<SessionLaunchBoundary, keyof SessionLaunchBoundary> &
  Pick<SessionQueueDependencies, "runnerIsAvailable">;

export function createRealtimeSessionCommands(
  options: CreateRealtimeSessionCommandsOptions,
): RealtimeSessionCommands {
  return new RealtimeSessionCommands({
    ...options,
    availability: options,
    lifecycle: options,
  });
}
