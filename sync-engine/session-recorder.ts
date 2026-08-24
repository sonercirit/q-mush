import type {
  SessionRecordedOutput,
  SessionTerminalOutput,
} from "./session-recorder-types.ts";
import { invokeRuntimeWrite } from "./session-runtime-write.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionRecorder {
  readonly messages: (...output: SessionRecordedOutput) => void;
  readonly terminal: (...output: SessionTerminalOutput) => void;
}

export function createSessionRecorder(
  store: SessionStore,
  sessionId: string,
  now: () => number,
  notify: () => void,
  generation: number,
  userId: string,
): SessionRecorder {
  const guardedNotify = (): void => {
    if (store.executionIsCurrent(userId, sessionId, generation)) {
      notify();
    }
  };
  const record = (
    action: (time: number, currentGeneration: number) => void,
  ) => {
    invokeRuntimeWrite(now, generation, action, guardedNotify);
  };
  return {
    messages: (messages, usage) => {
      record((time, currentGeneration) => {
        store.appendRuntimeAgentMessages(
          sessionId,
          messages,
          time,
          currentGeneration,
          usage,
        );
      });
    },
    terminal: (messages, restartHandoff, usage) => {
      record((time, currentGeneration) => {
        store.commitRuntimeTerminal(
          sessionId,
          messages,
          time,
          currentGeneration,
          restartHandoff,
          usage,
        );
      });
    },
  };
}
