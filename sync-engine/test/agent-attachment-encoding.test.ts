import { describe, expect, test } from "vitest";
import type { AgentAttachment } from "../../shared/agent-attachments.ts";
import {
  providerChatMessage,
  providerResponsesInput,
} from "../provider-attachment-input.ts";

const DATA = Uint8Array.from([1, 2, 3]).toBase64();
const attachment = (
  mediaType: AgentAttachment["mediaType"],
  name: string,
): AgentAttachment => ({ data: DATA, mediaType, name });

const ATTACHMENTS = [
  attachment("image/png", "screen.png"),
  attachment("video/mp4", "demo.mp4"),
  attachment("audio/mpeg", "note.mp3"),
  attachment("application/pdf", "spec.pdf"),
  attachment("text/plain", "notes.txt"),
] as const;

describe("provider-native attachment encoding", () => {
  const prepare = (protocol: "chat" | "responses"): readonly unknown[] =>
    protocol === "chat"
      ? [
          providerChatMessage({
            attachments: ATTACHMENTS,
            content: "Inspect",
            role: "user",
          }),
        ]
      : providerResponsesInput({
          attachments: ATTACHMENTS,
          content: "Inspect",
          role: "user",
        });

  test("encodes all five supported attachment modalities for chat completions", () => {
    expect(prepare("chat")[0]).toMatchObject({
      content: [
        { text: "Inspect", type: "text" },
        { type: "image_url" },
        { type: "video_url" },
        { type: "input_audio" },
        { type: "file" },
        { type: "file" },
      ],
      role: "user",
    });
  });

  test("encodes all five supported attachment modalities for Responses", () => {
    expect(prepare("responses")).toMatchObject([
      {
        content: [
          { text: "Inspect", type: "input_text" },
          { type: "input_image" },
          { type: "input_video" },
          { type: "input_audio" },
          { type: "input_file" },
          { type: "input_file" },
        ],
      },
    ]);
  });
});
