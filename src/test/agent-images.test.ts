import { describe, expect, test } from "bun:test";
import {
  agentImageDataUrl,
  MAXIMUM_AGENT_IMAGES,
  readAgentImages,
} from "../agent-images.ts";
import { appendAgentImageFiles } from "../session-image-input.ts";
import { readPrompt } from "../session-input.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";

describe("agent images", () => {
  test("reads supported base64-encoded images", () => {
    expect(readAgentImages(undefined)).toEqual([]);
    expect(readAgentImages([TEST_AGENT_IMAGE])).toEqual([TEST_AGENT_IMAGE]);
    expect(agentImageDataUrl(TEST_AGENT_IMAGE)).toBe(
      `data:image/png;base64,${TEST_AGENT_IMAGE.data}`,
    );
  });

  test("rejects malformed, unsafe, and excessive image inputs", () => {
    expect(
      readAgentImages([{ ...TEST_AGENT_IMAGE, mediaType: "image/svg+xml" }]),
    ).toBeUndefined();
    expect(
      readAgentImages([{ ...TEST_AGENT_IMAGE, data: "not base64" }]),
    ).toBeUndefined();
    expect(
      readAgentImages(
        Array.from(
          { length: MAXIMUM_AGENT_IMAGES + 1 },
          () => TEST_AGENT_IMAGE,
        ),
      ),
    ).toBeUndefined();
  });

  test("accepts an image-only user message", () => {
    expect(readPrompt({ images: [TEST_AGENT_IMAGE], prompt: "" })).toEqual({
      images: [TEST_AGENT_IMAGE],
      prompt: "",
    });
    expect(readPrompt({ images: [], prompt: "" })).toBeUndefined();
  });

  test("encodes selected browser files and appends them to the draft", async () => {
    const bytes = Uint8Array.from(atob(TEST_AGENT_IMAGE.data), (value) =>
      value.charCodeAt(0),
    );
    const file = new File([bytes], TEST_AGENT_IMAGE.name, {
      type: TEST_AGENT_IMAGE.mediaType,
    });

    expect(await appendAgentImageFiles([], [file])).toEqual([TEST_AGENT_IMAGE]);
    expect(
      appendAgentImageFiles(
        [],
        [new File(["unsafe"], "vector.svg", { type: "image/svg+xml" })],
      ),
    ).rejects.toThrow("PNG, JPEG, GIF, or WebP");
  });
});
