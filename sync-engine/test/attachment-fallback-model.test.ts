import { describe, expect, test, vi } from "vitest";
import type { AgentAttachment } from "../../shared/agent-attachments.ts";
import type { AttachmentFallbackSelection } from "../../shared/attachment-fallback.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";

import { explainAttachment } from "../attachment-fallback-model.ts";
import type { AgentModelFactory } from "../session-agent-models.ts";
import { providerStep } from "./provider-step-fixtures.ts";

const ATTACHMENT: AgentAttachment = {
  data: Uint8Array.from([1]).toBase64(),
  mediaType: "application/pdf",
  name: "spec.pdf",
};
const FALLBACK: AttachmentFallbackSelection = {
  credentialId: "fallback-credential",
  modality: "pdf",
  model: "pdf-model",
  openRouterProviderTag: null,
  provider: "openai",
};
const CURRENT_CREDENTIAL = {
  accountId: null,
  id: "current-credential",
  isDefault: true,
  isGlobal: true,
  label: "Current",
  secret: "secret",
  source: "api_key" as const,
};
const FALLBACK_CREDENTIAL = {
  ...CURRENT_CREDENTIAL,
  id: FALLBACK.credentialId,
  label: "Fallback",
};

function options(
  inputModalities: readonly string[] | null,
  selections = [FALLBACK],
) {
  const stepStarts: string[] = [];
  const requestStates: ("active" | "admission")[] = [];
  const requestStateCallbacks: NonNullable<
    Parameters<AgentModelFactory>[0]["onRequestState"]
  >[] = [];
  const complete = vi.fn(() => {
    // Records ordering: the step must be marked before the request.
    stepStarts.push("complete");
    return Promise.resolve(providerStep("explained"));
  });
  const factory = vi.fn((factoryOptions: Parameters<AgentModelFactory>[0]) => {
    if (factoryOptions.onRequestState !== undefined) {
      requestStateCallbacks.push(factoryOptions.onRequestState);
    }
    return { complete };
  });
  return {
    complete,
    factory,
    requestStateCallbacks,
    requestStates,
    stepStarts,
    value: {
      attachment: ATTACHMENT,
      onStepStart: () => {
        stepStarts.push("step-start");
      },
      currentCredential: CURRENT_CREDENTIAL,
      currentModel: testAgentModelOption({
        id: "current-model",
        inputModalities,
        label: "Current",
      }),
      currentModelId: "current-model",
      currentProvider: "openai" as const,
      currentProviderPricing: null,
      currentProviderTag: null,
      factory,
      onRequestState: (state: "active" | "admission") => {
        requestStates.push(state);
      },
      prompt: "Extract requirements",
      toolSettings: DEFAULT_TOOL_SETTINGS,
      resources: {
        attachmentFallbacks: () => selections,
        discoverModels: () =>
          Promise.resolve({
            defaultModel: "pdf-model",
            models: [
              testAgentModelOption({
                id: "pdf-model",
                label: "PDF model",
                maxOutputTokens: 32_000,
              }),
            ],
          }),
        readCredential: () => Promise.resolve(FALLBACK_CREDENTIAL),
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    },
  };
}

async function expectFallbackRequired(
  inputModalities: readonly string[] | null,
  message: string,
): Promise<void> {
  const setup = options(inputModalities, []);
  await expect(explainAttachment(setup.value)).rejects.toThrow(message);
  expect(setup.factory).not.toHaveBeenCalled();
}

describe("explain attachment", () => {
  test("uses the per-call prompt and configured fallback for unreadable files", async () => {
    const setup = options(["text"]);

    await expect(explainAttachment(setup.value)).resolves.toMatchObject({
      content: "explained",
      model: "pdf-model",
      provider: "openai",
    });

    // A slow explanation is its own visible step, marked before the
    // request, not a continuation of the preceding agent step.
    expect(setup.stepStarts).toEqual(["step-start", "complete"]);

    expect(setup.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: FALLBACK_CREDENTIAL,
        maxOutputTokens: 32_000,
        model: "pdf-model",
        providerPricing: null,
        systemPrompt: "Extract requirements",
      }),
    );
    expect(setup.requestStateCallbacks).toHaveLength(1);
    setup.requestStateCallbacks[0]?.("admission");
    expect(setup.requestStates).toEqual(["admission"]);
  });

  test("appends the truncation notice to a length-stopped explanation", async () => {
    const setup = options(["text"]);
    const factory = vi.fn(() => ({
      complete: () =>
        Promise.resolve({
          ...providerStep("Partial explanation"),
          truncation: "max_tokens" as const,
        }),
    }));

    const explanation = await explainAttachment({ ...setup.value, factory });

    // The tool result must not read as a finished explanation.
    expect(explanation.content).toContain("Partial explanation");
    expect(explanation.content).toContain("truncated");
    expect(explanation.content).toContain("maximum output tokens");
  });

  test("uses the session model when it supports the file modality", async () => {
    const setup = options(["text", "file"]);

    await explainAttachment(setup.value);

    expect(setup.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: CURRENT_CREDENTIAL,
        model: "current-model",
      }),
    );
  });

  test("reports the global setting when no fallback can read the file", async () => {
    await expectFallbackRequired(["text"], "Configure a global pdf fallback");
  });

  test("does not claim support when model modalities are unknown", async () => {
    await expectFallbackRequired(null, "with reported support");
  });
});
