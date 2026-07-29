import { describe, expect, test, vi } from "vitest";
import type { AgentAttachment } from "../../shared/agent-attachments.ts";
import type { AttachmentFallbackSelection } from "../../shared/attachment-fallback.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { explainAttachment } from "../attachment-fallback-model.ts";
import { providerTurn } from "./provider-turn-fixtures.ts";

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

function options(inputModalities: readonly string[], selections = [FALLBACK]) {
  const complete = vi.fn(() => Promise.resolve(providerTurn("explained")));
  const factory = vi.fn(() => ({ complete }));
  return {
    complete,
    factory,
    value: {
      attachment: ATTACHMENT,
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
      prompt: "Extract requirements",
      resources: {
        attachmentFallbacks: () => selections,
        discoverModels: () =>
          Promise.resolve({
            defaultModel: "pdf-model",
            models: [
              testAgentModelOption({ id: "pdf-model", label: "PDF model" }),
            ],
          }),
        readCredential: () => Promise.resolve(FALLBACK_CREDENTIAL),
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    },
  };
}

describe("explain attachment", () => {
  test("uses the per-call prompt and configured fallback for unreadable files", async () => {
    const setup = options(["text"]);

    await expect(explainAttachment(setup.value)).resolves.toMatchObject({
      content: "explained",
      model: "pdf-model",
      provider: "openai",
    });

    expect(setup.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: FALLBACK_CREDENTIAL,
        model: "pdf-model",
        providerPricing: null,
        systemPrompt: "Extract requirements",
      }),
    );
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
    const setup = options(["text"], []);

    await expect(explainAttachment(setup.value)).rejects.toThrow(
      "Configure the global pdf fallback",
    );
    expect(setup.factory).not.toHaveBeenCalled();
  });
});
