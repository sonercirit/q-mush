import { describe, expect, test } from "vitest";
import {
  agentAttachmentModality,
  readAgentAttachments,
  type AgentAttachment,
} from "../agent-attachments.ts";

const IMAGE: AgentAttachment = {
  data: "aQ==",
  mediaType: "image/png",
  name: "pixel.png",
};
const PDF: AgentAttachment = {
  data: "cGRm",
  mediaType: "application/pdf",
  name: "brief.pdf",
};

describe("agent attachments", () => {
  test("accepts image, video, audio, PDF, and generic file attachments", () => {
    const attachments: readonly AgentAttachment[] = [
      IMAGE,
      { ...IMAGE, mediaType: "video/mp4", name: "clip.mp4" },
      { ...IMAGE, mediaType: "audio/mpeg", name: "sound.mp3" },
      PDF,
      { ...IMAGE, mediaType: "text/plain", name: "notes.txt" },
    ];

    expect(readAgentAttachments(attachments)).toEqual(attachments);
    expect(
      attachments.map((attachment) => agentAttachmentModality(attachment)),
    ).toEqual(["image", "video", "audio", "pdf", "file"]);
  });

  test("rejects unsupported and malformed attachments", () => {
    expect(
      readAgentAttachments([{ ...IMAGE, mediaType: "image/svg+xml" }]),
    ).toBeUndefined();
    expect(
      readAgentAttachments([{ ...IMAGE, data: "not base64" }]),
    ).toBeUndefined();
  });
});
