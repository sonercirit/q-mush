import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModel,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import {
  emptyProviderToolCall,
  providerStep,
} from "./provider-step-fixtures.ts";

interface QueuedInput {
  readonly content: string;
  readonly kind: "follow_up" | "steer";
}

function queuedInputs(initial: readonly QueuedInput[]) {
  let pending = [...initial];
  return {
    pending: () => pending,
    queue: (input: QueuedInput) => {
      pending.push(input);
    },
    takeSteeringMessages: () => {
      if (pending[0]?.kind !== "steer") return [];

      const [steering, ...remaining] = pending;
      pending = remaining;
      return [{ content: steering.content, role: "user" as const }];
    },
  };
}

function recordingModel(
  requests: unknown[][],
  complete: (requestCount: number) => ReturnType<AgentModel["complete"]>,
): AgentModel {
  return {
    complete: (messages) => {
      requests.push([...messages]);
      return complete(requests.length);
    },
  };
}

async function runSteeringLoop(options: {
  readonly executeOutput: string;
  readonly model: AgentModel;
  readonly recordMessage?: (messages: readonly AgentRecordedMessage[]) => void;
  readonly takeSteeringMessages: NonNullable<
    Parameters<typeof runAgentLoop>[0]["takeSteeringMessages"]
  >;
}): Promise<void> {
  await runAgentLoop({
    executeTool: () => Promise.resolve(options.executeOutput),
    initialMessages: [{ content: "Initial task", role: "user" }],
    model: options.model,
    recordMessage: options.recordMessage ?? (() => undefined),
    takeSteeringMessages: options.takeSteeringMessages,
  });
}

function toolStep(content: string) {
  return providerStep(content, {
    toolCalls: [emptyProviderToolCall("call-1", "read")],
  });
}

describe("agent-loop steering boundaries", () => {
  test("consumes steering after an in-flight step settles", async () => {
    const requests: unknown[][] = [];
    const steps = [toolStep("Inspecting."), providerStep("Done.")];
    const recorded: AgentRecordedMessage[] = [];
    const pending = queuedInputs([]);
    await runSteeringLoop({
      executeOutput: "Tool output",
      model: recordingModel(requests, () => {
        const next = steps.shift();
        if (next === undefined) throw new Error("Unexpected model request");
        return Promise.resolve(next).then((step) => {
          if (requests.length === 1) {
            pending.queue({ content: "Change direction", kind: "steer" });
          }
          return step;
        });
      }),
      recordMessage: (messages) => {
        recorded.push(...messages);
      },
      takeSteeringMessages: pending.takeSteeringMessages,
    });
    expect(requests[1]).toEqual([
      { content: "Initial task", role: "user" },
      {
        content: "Inspecting.",
        role: "assistant",
        toolCalls: [{ arguments: "{}", id: "call-1", name: "read" }],
      },
      {
        content: "Tool output",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read",
      },
      { content: "Change direction", role: "user" },
    ]);
    expect(recorded.at(-1)).toMatchObject({ content: "Done." });
  });

  test("continues a terminal model step when steering is ready", async () => {
    const requests: unknown[][] = [];
    const pending = queuedInputs([
      { content: "One more thing", kind: "steer" },
    ]);
    await runSteeringLoop({
      executeOutput: "unused",
      model: recordingModel(requests, (requestCount) =>
        Promise.resolve(
          providerStep(requestCount === 1 ? "First answer" : "Steered answer"),
        ),
      ),
      takeSteeringMessages: pending.takeSteeringMessages,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.at(-1)).toEqual({
      content: "One more thing",
      role: "user",
    });
  });

  test("keeps steering queued when a step handoff wins the boundary", async () => {
    const requests: unknown[][] = [];
    const queuedSteering = {
      content: "Wait for restart",
      kind: "steer" as const,
    };
    const pending = queuedInputs([queuedSteering]);
    const result = await runAgentLoop({
      executeTool: () => Promise.resolve("Tool output"),
      handoffRequested: () => true,
      initialMessages: [{ content: "Initial task", role: "user" }],
      model: recordingModel(requests, () =>
        Promise.resolve(toolStep("Working.")),
      ),
      recordMessage: () => undefined,
      takeSteeringMessages: pending.takeSteeringMessages,
    });

    expect(result.status).toBe("handoff");
    expect(requests).toHaveLength(0);
    expect(pending.pending()).toEqual([queuedSteering]);
  });

  test("keeps follow-ups queued at a step boundary", async () => {
    const requests: unknown[][] = [];
    const queuedFollowUp = { content: "Next turn", kind: "follow_up" } as const;
    const pending = queuedInputs([
      queuedFollowUp,
      { content: "Change direction", kind: "steer" },
    ]);
    const model = new (class implements AgentModel {
      complete(messages: Parameters<AgentModel["complete"]>[0]) {
        requests.push([...messages]);
        return Promise.resolve(
          requests.length > 1 ? providerStep("Done.") : toolStep("Working."),
        );
      }
    })();

    await runSteeringLoop({
      executeOutput: "Tool output",
      model,
      takeSteeringMessages: pending.takeSteeringMessages,
    });

    expect(requests.length).toBe(2);
    expect(requests[1]?.at(-1)).toMatchObject({ role: "tool" });
    expect(pending.pending()[0]).toBe(queuedFollowUp);
    expect(pending.pending()[1]).toMatchObject({ kind: "steer" });
  });
});
