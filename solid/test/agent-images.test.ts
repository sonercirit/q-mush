import { describe, expect, test } from "vitest";
import {
  agentAttachmentDataUrl,
  MAXIMUM_AGENT_ATTACHMENTS,
  readAgentAttachments,
} from "../../shared/agent-attachments.ts";
import {
  appendAgentImageFiles,
  readPastedAgentImageFiles,
} from "../../solid/session-image-input.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";

function testImageFile(name = TEST_AGENT_IMAGE.name): File {
  const bytes = Uint8Array.from(atob(TEST_AGENT_IMAGE.data), (value) =>
    value.charCodeAt(0),
  );
  return name.length === 0
    ? new EmptyNameFile([bytes], TEST_AGENT_IMAGE.name, {
        type: TEST_AGENT_IMAGE.mediaType,
      })
    : new File([bytes], name, { type: TEST_AGENT_IMAGE.mediaType });
}

class EmptyNameFile extends File {
  override get name(): string {
    return "";
  }
}

function clipboardEvent(options: {
  readonly files?: readonly File[];
  readonly itemFiles?: readonly (File | null)[];
  readonly onPreventDefault: () => void;
}) {
  return {
    clipboardData: {
      files: options.files ?? [],
      items: (options.itemFiles ?? []).map((file) => ({
        getAsFile: () => file,
        kind: file === null ? "string" : "file",
      })),
    },
    preventDefault: options.onPreventDefault,
  };
}

describe("agent images", () => {
  test("reads supported base64-encoded images", () => {
    expect(readAgentAttachments(undefined)).toEqual([]);
    expect(readAgentAttachments([TEST_AGENT_IMAGE])).toEqual([
      TEST_AGENT_IMAGE,
    ]);
    expect(agentAttachmentDataUrl(TEST_AGENT_IMAGE)).toBe(
      `data:image/png;base64,${TEST_AGENT_IMAGE.data}`,
    );
  });

  test("rejects malformed, unsafe, and excessive image inputs", () => {
    expect(
      readAgentAttachments([
        { ...TEST_AGENT_IMAGE, mediaType: "image/svg+xml" },
      ]),
    ).toBeUndefined();
    expect(
      readAgentAttachments([{ ...TEST_AGENT_IMAGE, data: "not base64" }]),
    ).toBeUndefined();
    expect(
      readAgentAttachments(
        Array.from(
          { length: MAXIMUM_AGENT_ATTACHMENTS + 1 },
          () => TEST_AGENT_IMAGE,
        ),
      ),
    ).toBeUndefined();
  });

  test("encodes supported selected files and appends them to the draft", async () => {
    const file = testImageFile();
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

    expect(await appendAgentImageFiles([], [file])).toEqual([TEST_AGENT_IMAGE]);
    expect(await appendAgentImageFiles([], [pdf])).toEqual([
      {
        data: "cGRm",
        mediaType: "application/pdf",
        name: "brief.pdf",
      },
    ]);
    await expect(
      appendAgentImageFiles(
        [],
        [new File(["unsafe"], "vector.svg", { type: "image/svg+xml" })],
      ),
    ).rejects.toThrow("supported image, video, audio, PDF");
  });

  test("reads supported files pasted from the clipboard", async () => {
    const image = testImageFile("");
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    let prevented = false;
    const preventDefault = () => {
      prevented = true;
    };
    const pasted = readPastedAgentImageFiles(
      clipboardEvent({
        itemFiles: [null, image],
        onPreventDefault: preventDefault,
      }),
    );

    expect(pasted[0]?.name).toBe("pasted-image.png");
    expect(await appendAgentImageFiles([], pasted)).toEqual([
      { ...TEST_AGENT_IMAGE, name: "pasted-image.png" },
    ]);
    expect(prevented).toBe(true);

    prevented = false;
    const fallbackFiles = readPastedAgentImageFiles(
      clipboardEvent({ files: [image], onPreventDefault: preventDefault }),
    );
    expect(fallbackFiles[0]?.name).toBe("pasted-image.png");
    expect(prevented).toBe(true);

    prevented = false;
    const textFiles = readPastedAgentImageFiles(
      clipboardEvent({ itemFiles: [text], onPreventDefault: preventDefault }),
    );
    expect(textFiles).toEqual([text]);
    expect(prevented).toBe(true);
  });
});
