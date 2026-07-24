import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";

export interface SessionIntegration {
  collection(request: Request): Response | Promise<Response>;
  compact(request: Request, sessionId: string): Promise<Response>;
  compaction(request: Request, sessionId: string): Promise<Response>;
  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    output: string,
  ): boolean;
  continue(request: Request, sessionId: string): Promise<Response>;
  deliverRunnerCommands(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void;
  detailForUser(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined;
  directories(request: Request, runnerId: string): Promise<Response>;
  drain(): Promise<void>;
  item(request: Request, sessionId: string): Response;
  listForUser(userId: string): readonly AgentSessionSummary[];
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  onChange(listener: (userId: string, sessionId: string) => void): void;
  reassign(request: Request, sessionId: string): Promise<Response>;
  runnerConnected(): void;
  runnerRemoved(userId: string, runnerId: string): Promise<void>;
  stop(request: Request, sessionId: string): Promise<Response>;
}
