import { describe, expect, test } from "vitest";
import {
  anthropicHarnessWithFollowUp,
  serverToolReplayBlock,
  textReplayBlock,
  thinkingReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import { capturedReplayRequest } from "./anthropic-replay-request-helpers.ts";
import {
  anthropicPauseTurnResponse,
  anthropicReplayResponse,
} from "./anthropic-response-event-fixtures.ts";

const WHITESPACE_TEXT = textReplayBlock(" ");
const SEARCH_TOOL = serverToolReplayBlock({
  id: "srvtoolu_1",
  input: { query: "news" },
  name: "web_search",
});

function whitespaceReplayResponse(stream: boolean): Response {
  return anthropicReplayResponse(
    [
      thinkingReplayBlock("signed-thinking", "Inspect."),
      WHITESPACE_TEXT,
      textReplayBlock("Answer."),
    ],
    { stream },
  );
}

async function completedFollowUp(response: Response) {
  const harness = anthropicHarnessWithFollowUp(response);
  return { harness, step: await harness.complete() };
}

describe("Anthropic whitespace replay text", () => {
  test.each([true, false])(
    "keeps %s-streamed whitespace text replayable without sending blank blocks",
    async (stream) => {
      const { harness, step } = await completedFollowUp(
        whitespaceReplayResponse(stream),
      );

      expect(step.content).toEqual(" Answer.");
      expect(step.toolCalls).toHaveLength(0);
      const replay = step.providerReplay;
      expect(replay).toBeDefined();
      expect(replay?.blocks).toContainEqual(WHITESPACE_TEXT);

      // The replay still matches the assistant message, so it is replayed —
      // minus the blank block the Messages API rejects.
      const replayed = await capturedReplayRequest(harness, step, {
        content: "Continue",
        role: "user",
      });
      expect(replayed).toEqual([
        thinkingReplayBlock("signed-thinking", "Inspect."),
        textReplayBlock("Answer."),
      ]);
    },
  );

  test.each([true, false])(
    "continues a %s-streamed paused turn whose text is whitespace",
    async (stream) => {
      const { harness, step } = await completedFollowUp(
        anthropicPauseTurnResponse([WHITESPACE_TEXT, SEARCH_TOOL], stream),
      );

      expect(step.content).toBe(" Done.");
      const continuation = await harness.requestBody(1);
      expect(continuation).toMatchObject({
        messages: [
          { role: "user" },
          { content: [SEARCH_TOOL], role: "assistant" },
        ],
      });
      expect(JSON.stringify(continuation)).not.toContain('"text":" "');
    },
  );
});
