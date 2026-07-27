import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type { GoogleAuth } from "./auth.ts";
import type { RealtimeHub, RealtimeSocket } from "./realtime-hub.ts";
import type {
  RunnerActivationReceiptValidation,
  RunnerIntegration,
} from "./runners.ts";
import type { SessionIntegration } from "./sessions.ts";

export type RealtimeReceiptState = RunnerActivationReceiptValidation &
  Readonly<{ receipt: string }>;

type RealtimeRunnerIntegration = RunnerIntegration;

export interface RealtimeRegistrationDependencies {
  readonly auth: GoogleAuth;
  readonly authRevalidationIntervalMs?: number;
  readonly clearInterval?: (id: number) => void;
  readonly hub: RealtimeHub;
  readonly instanceId?: string;
  readonly runnerVersion: string;
  readonly runners: RealtimeRunnerIntegration;
  readonly sendCommand: (
    socket: RealtimeSocket,
    command: RunnerToolCommand,
  ) => boolean;
  readonly sessions: SessionIntegration;
  readonly setInterval?: (callback: () => void, interval: number) => number;
}
