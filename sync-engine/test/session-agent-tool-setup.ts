import { expect } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionInput,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
} from "./session-integration-helpers.ts";

export function toolCall(name: string, arguments_: unknown) {
  return {
    arguments: JSON.stringify(arguments_),
    id: `call-${name}`,
    name,
  };
}

export async function completedParentDetail(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  status: string,
): Promise<unknown> {
  for (;;) {
    const value = await sessionDetail(setup.sessions);
    if (hasSessionStatus(status)(value)) {
      return value;
    }
    await Bun.sleep(1);
  }
}

export async function startToolSession(model: AgentModel) {
  const setup = connectedSessionSetup(model);
  const detail = await setup.sessions.createForUser(
    {
      email: "mushroom@example.com",
      id: "018bcfe5-6800-7000-8000-000000000021",
      name: "Mush Room",
    },
    createSessionInput(),
  );
  expect(detail.status).toBe("queued");
  await completeAgentFileLookup(setup);
  return setup;
}

export function scriptedModel(
  turns: ConstructorParameters<typeof ScriptedAgentModel>[0],
): ScriptedAgentModel {
  return new ScriptedAgentModel(turns);
}
