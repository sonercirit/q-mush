import type { AgentModel } from "../../shared/agent-loop.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { spawnCall } from "./session-agent-spawn-helpers.ts";
import { toolCall } from "./session-agent-tool-setup.ts";

export interface PausedParentChildModel {
  readonly complete: AgentModel["complete"];
  readonly parentPaused: Promise<void>;
  readonly resumeParent: () => void;
}
export function createPausedParentChildModel(): PausedParentChildModel {
  let requestCount = 0;
  let releaseParent: (() => void) | undefined;
  const resumeParent = Promise.withResolvers<undefined>();
  const parentPaused = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  return {
    parentPaused,
    resumeParent: () => {
      resumeParent.resolve(undefined);
    },
    complete: async () => {
      requestCount += 1;
      let content: string;
      let toolCalls: ReturnType<typeof spawnCall>[];
      if (requestCount === 1) {
        content = "Delegating while I keep running.";
        toolCalls = [spawnCall("Complete while the parent is paused")];
      } else if (requestCount === 2) {
        releaseParent?.();
        await resumeParent.promise;
        content = "Parent reached its safe stop boundary.";
        toolCalls = [];
      } else if (requestCount === 3) {
        content = "Child final result.";
        toolCalls = [];
      } else {
        content = "Parent received the child result.";
        toolCalls = [];
      }
      return providerStep(content, { toolCalls });
    },
  };
}
export interface SelfStoppingChildModel {
  childSessionId: string | undefined;
  readonly complete: AgentModel["complete"];
}
export function createSelfStoppingChildModel(): SelfStoppingChildModel {
  let stepNumber = 0;
  const model: SelfStoppingChildModel = {
    childSessionId: undefined,
    complete: () => {
      stepNumber += 1;
      const childSessionId = model.childSessionId;
      const step =
        stepNumber === 1
          ? {
              content: "Delegating stoppable work.",
              toolCalls: [
                spawnCall("Stop this delegated task", undefined, [
                  "stop_session",
                ]),
              ],
            }
          : stepNumber === 2
            ? { content: "Parent complete.", toolCalls: [] }
            : stepNumber === 3
              ? childSessionId === undefined
                ? undefined
                : {
                    content: "Stopping child.",
                    toolCalls: [
                      toolCall("stop_session", { sessionId: childSessionId }),
                    ],
                  }
              : { content: "Stop report received.", toolCalls: [] };
      if (step === undefined) {
        throw new Error("The child session ID is not available");
      }
      return Promise.resolve({
        ...step,
        contextTokens: null,
        costUsd: null,
        thinking: "",
        tokenUsage: null,
      });
    },
  };
  return model;
}
