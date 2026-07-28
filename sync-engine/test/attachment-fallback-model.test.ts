import { describe, expect, test, vi } from "vitest";
import type { AgentAttachment } from "../../shared/agent-attachments.ts";
import type { AgentModel } from "../../shared/agent-loop.ts";
import type { AttachmentFallbackSelection } from "../../shared/attachment-fallback.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { AttachmentFallbackAgentModel } from "../attachment-fallback-model.ts";
import { providerTurn } from "./provider-turn-fixtures.ts";

const ATTACHMENT: AgentAttachment = {
  data: Uint8Array.from([1]).toBase64(),
  mediaType: "application/pdf",
  name: "spec.pdf",
};
const CURRENT_MODEL = testAgentModelOption({
  contextWindow: null,
  id: "text-model",
  label: "Text model",
});
const SELECTION: AttachmentFallbackSelection = {
  credentialId: "credential-1",
  modality: "pdf",
  model: "pdf-model",
  prompt: "Extract requirements",
  provider: "openai",
};

describe("attachment fallback model", () => {
  test("converts unsupported attachments once and reuses the safe text reference on replay", async () => {
    const seen: unknown[] = [];
    const model: AgentModel = {
      complete: (messages) => {
        seen.push(messages);
        return Promise.resolve(providerTurn("done"));
      },
    };
    const convert = vi.fn(
      (call: {
        readonly attachment: AgentAttachment;
        readonly selection: AttachmentFallbackSelection;
      }) => {
        expect(call.selection).toEqual(SELECTION);
        return Promise.resolve({
          reference: "q-mush-attachment://pdf/id/spec.pdf",
          text: "Requirement one",
        });
      },
    );
    const fallback = new AttachmentFallbackAgentModel({
      convert,
      currentModel: CURRENT_MODEL,
      model,
      selections: [SELECTION],
    });
    const messages = [
      { attachments: [ATTACHMENT], content: "Review", role: "user" as const },
    ];

    await fallback.complete(messages);
    await fallback.complete(messages);

    expect(convert).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual([
      {
        content:
          "Review\n\nAttachment fallback (pdf, spec.pdf): Requirement one\nReference: q-mush-attachment://pdf/id/spec.pdf",
        role: "user",
      },
    ]);
  });
});
