import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
  RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";

import type { SessionDetailReader } from "./session-command-types.ts";
import type { SessionRealtimeCommands } from "./session-realtime-commands.ts";
import type { DurableRunnerRestartGate } from "./session-restart-coordinator.ts";

export type DeliverRunnerCommands = (
  runnerId: string,
  deliver: (command: RunnerToolCommand) => boolean,
  connectionGeneration?: number,
) => boolean;

export interface SessionIntegration extends SessionDetailReader {
  attachmentFallbacks?(request: Request): Promise<Response> | Response;
  collection(request: Request): Response | Promise<Response>;
  compact(request: Request, sessionId: string): Promise<Response>;
  compaction(request: Request, sessionId: string): Promise<Response>;
  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    result: RunnerCommandResult,
  ): boolean;
  continue(request: Request, sessionId: string): Promise<Response>;
  deliverRunnerCommands: DeliverRunnerCommands;
  runnerConnectionGeneration(runnerId: string): number;
  replaceRunnerConnection(runnerId: string, replacedGeneration: number): void;
  directories(request: Request, runnerId: string): Promise<Response>;
  drain(): Promise<void>;
  prepareFinalShutdown(): Promise<void>;
  reconcileDatabaseWrites(): void;
  item(request: Request, sessionId: string): Response;
  listForUser(
    userId: string,
    workspaceId?: string,
  ): readonly AgentSessionSummary[];
  pendingQuestionForUser(
    userId: string,
    sessionId: string,
  ): PendingAskQuestions | null;
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  openRouterProviders(request: Request): Promise<Response>;
  pendingRunnerRestart(runnerId: string): DurableRunnerRestartGate;
  readonly realtimeCommands: SessionRealtimeCommands;
  onChange(listener: (userId: string, sessionId: string) => void): void;
  reassign(request: Request, sessionId: string): Promise<Response>;
  drainRunner(runnerId: string, restartId: string): Promise<void>;
  runnerConnected(runnerId: string): void;
  runnerDisconnected(runnerId: string): void;
  streamRunnerCommand(
    runnerId: string,
    commandId: string,
    delta: RunnerCommandOutputDelta,
  ): boolean;
  runnerRestartReady(runnerId: string, restartId: string): void;
  runnerRemoved(userId: string, runnerId: string): Promise<void>;
  stop(request: Request, sessionId: string): Promise<Response>;
}
