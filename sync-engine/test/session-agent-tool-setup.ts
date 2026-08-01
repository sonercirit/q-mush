import { expect } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { findToolResultContents } from "./session-agent-tool-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

export function toolCall(
  name: string,
  arguments_: unknown,
  id = `call-${name}`,
) {
  return {
    arguments: JSON.stringify(arguments_),
    id,
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

export async function startToolSessionSetup(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  agentFile: unknown = null,
): Promise<void> {
  const response = await setup.sessions.collection(createSessionRequest());
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup, agentFile);
}

export async function startToolSession(
  model: AgentModel,
  options: Parameters<typeof connectedSessionSetup>[3] & {
    readonly agentFile?: unknown;
  } = {},
  discoverModels?: Parameters<typeof connectedSessionSetup>[2],
) {
  const { agentFile = null, ...sessionOptions } = options;
  const setup = connectedSessionSetup(
    model,
    "api_key",
    discoverModels,
    sessionOptions,
  );
  await startToolSessionSetup(setup, agentFile);
  return setup;
}

export async function completedParentToolOutputs(
  model: AgentModel,
  name: string,
): Promise<{
  readonly outputs: readonly string[];
  readonly setup: Awaited<ReturnType<typeof connectedSessionSetup>>;
}> {
  const setup = await startToolSession(model);
  const detail = await completedParentDetail(setup, "idle");
  return { outputs: findToolResultContents(detail, name), setup };
}

function waitForDetail(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  return waitForSessionValue(() => sessionDetail(setup.sessions), predicate);
}

export function waitForSessionContent(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  content: string,
): Promise<unknown> {
  return waitForDetail(setup, (value) =>
    JSON.stringify(value).includes(content),
  );
}

export function waitForToolResults(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  name: string,
  count: number,
): Promise<unknown> {
  return waitForDetail(
    setup,
    (value) => findToolResultContents(value, name).length === count,
  );
}

export function scriptedModel(
  steps: ConstructorParameters<typeof ScriptedAgentModel>[0],
): ScriptedAgentModel {
  return new ScriptedAgentModel(steps);
}
