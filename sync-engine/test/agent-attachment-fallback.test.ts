import { describe, expect, test, vi } from "vitest";
import type { AgentAttachment } from "../../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import {
  attachmentFallbackReference,
  prepareAttachmentFallbacks,
} from "../agent-attachment-fallback.ts";

const ATTACHMENT: AgentAttachment = {
  data: Uint8Array.from([1, 2, 3]).toBase64(),
  mediaType: "image/png",
  name: "design.png",
};

function model(inputModalities: readonly string[]) {
  return testAgentModelOption({
    contextWindow: 8_192,
    id: "text-model",
    inputModalities,
    label: "Text model",
  });
}

const messages: readonly AgentConversationMessage[] = [
  { attachments: [ATTACHMENT], content: "Review this", role: "user" },
];

describe("attachment fallback routing", () => {
  test("preserves the provider-native image path when the current model supports it", async () => {
    const convert = vi.fn();
    const prepared = await prepareAttachmentFallbacks({
      convert,
      currentModel: model(["text", "image"]),
      messages,
      selections: [],
    });

    expect(prepared).toEqual(messages);
    expect(convert).not.toHaveBeenCalled();
  });

  test("routes unsupported attachments through a selected modality model and prompt", async () => {
    const convert = vi.fn(() =>
      Promise.resolve({
        reference: attachmentFallbackReference(
          "image",
          "design.png",
          "result-1",
        ),
        text: "A blue dashboard.",
      }),
    );
    const prepared = await prepareAttachmentFallbacks({
      convert,
      currentModel: model(["text"]),
      messages,
      selections: [
        {
          credentialId: "vision-key",
          modality: "image",
          model: "vision-model",
          prompt: "Describe UI details",
          provider: "openai",
        },
      ],
    });

    expect(convert).toHaveBeenCalledWith(
      ATTACHMENT,
      expect.objectContaining({
        model: "vision-model",
        prompt: "Describe UI details",
      }),
    );
    expect(prepared).toEqual([
      {
        content:
          "Review this\n\nAttachment fallback (image, design.png): A blue dashboard.\nReference: q-mush-attachment://image/result-1/design.png",
        role: "user",
      },
    ]);
  });

  test("rejects unsupported modalities without a capable configured fallback", async () => {
    await expect(
      prepareAttachmentFallbacks({
        convert: vi.fn(),
        currentModel: model(["text"]),
        messages,
        selections: [],
      }),
    ).rejects.toThrow("No image fallback model is configured");
  });

  test("creates encoded references without traversal or injected URI segments", () => {
    expect(attachmentFallbackReference("file", "../../a b?.txt", "id-1")).toBe(
      "q-mush-attachment://file/id-1/..%2F..%2Fa%20b%3F.txt",
    );
  });
});
