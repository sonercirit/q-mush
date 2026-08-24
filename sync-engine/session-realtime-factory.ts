import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionQueueDependencies } from "./session-queue.ts";
import type { SessionRealtimeCommands } from "./session-realtime-commands.ts";
import {
  createRealtimeSessionCommandsIntegration,
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
): SessionRealtimeCommands {
  return createRealtimeSessionCommandsIntegration({
    ...options,
    availability: options,
    lifecycle: options,
  });
}
