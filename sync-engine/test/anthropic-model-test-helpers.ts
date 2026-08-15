import type {
  AnthropicAssistantReplay,
  AnthropicReplayBlock,
  AnthropicReplayObject,
} from "../../shared/anthropic-replay.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";

type AnthropicModelOptions = ConstructorParameters<
  typeof ChatCompletionsAgentModel
>[0];

export const ANTHROPIC_TEST_BASE_URL = "https://anthropic.example.test/v1";
export const ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT =
  "test-credential-fingerprint";
export const ANTHROPIC_TEST_CREDENTIAL = {
  accountId: null,
  apiFormat: "anthropic",
  baseUrl: ANTHROPIC_TEST_BASE_URL,
  id: "anthropic-test-credential",
  secret: "anthropic-secret",
  source: "api_key",
} as const;
export const ANTHROPIC_TEST_PROVENANCE =
  "FwPE95nZlOp8Z5sD89zF_lKoX_HRmefp03ksFW-oJMc";
export const KNOWN_ANTHROPIC_MODEL = "claude-test-4";
export const ANTHROPIC_READ_CALL = {
  arguments: '{"path":"SETUP.md"}',
  id: "read-call",
  name: "read",
} as const;

export function thinkingReplayBlock(
  signature: string,
  thinking = "",
): AnthropicReplayBlock {
  return { signature, thinking, type: "thinking" };
}

export function redactedReplayBlock(data: string): AnthropicReplayBlock {
  return { data, type: "redacted_thinking" };
}

export function textReplayBlock(
  text: string,
  citations?: readonly AnthropicReplayObject[],
): AnthropicReplayBlock {
  return {
    ...(citations === undefined ? {} : { citations }),
    text,
    type: "text",
  };
}

interface ReplayToolBlockOptions {
  readonly caller?: AnthropicReplayObject;
  readonly id: string;
  readonly input: AnthropicReplayObject;
  readonly name: string;
}

function typedToolReplayBlock(
  options: ReplayToolBlockOptions,
  type: "server_tool_use" | "tool_use",
): AnthropicReplayBlock {
  return { ...options, type };
}

export function serverToolReplayBlock(
  options: ReplayToolBlockOptions,
): AnthropicReplayBlock {
  return typedToolReplayBlock(options, "server_tool_use");
}

export function toolReplayBlock(
  options: ReplayToolBlockOptions,
): AnthropicReplayBlock {
  return typedToolReplayBlock(options, "tool_use");
}

function anthropicReadReplayBlock(
  caller?: AnthropicReplayObject,
): AnthropicReplayBlock {
  return toolReplayBlock({
    ...(caller === undefined ? {} : { caller }),
    id: ANTHROPIC_READ_CALL.id,
    input: { path: "SETUP.md" },
    name: ANTHROPIC_READ_CALL.name,
  });
}

export const SIGNED_ANTHROPIC_REPLAY: AnthropicAssistantReplay = {
  blocks: [
    thinkingReplayBlock("omitted-signature"),
    redactedReplayBlock("redacted-data"),
    textReplayBlock("Reading.", [
      { cited_text: "source", type: "page_location" },
    ]),
    anthropicReadReplayBlock({ type: "direct" }),
  ],
  model: KNOWN_ANTHROPIC_MODEL,
  protocol: "anthropic",
  provenance: ANTHROPIC_TEST_PROVENANCE,
};

export const ANTHROPIC_READ_REPLAY_BLOCK = anthropicReadReplayBlock();

export const JSON_RESPONSE_REPLAY_BLOCKS = [
  thinkingReplayBlock("omitted-signature"),
  redactedReplayBlock("redacted-data"),
  textReplayBlock("Plain."),
  toolReplayBlock({
    id: "call-2",
    input: { command: "ls" },
    name: "bash",
  }),
] as const;

export function anthropicEvents(events: readonly unknown[]): Response {
  const body = events
    .map((event) =>
      isRecord(event)
        ? `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`
        : "",
    )
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

export function textStopAnthropicEvents(options: {
  readonly stopReason: string;
  readonly text: string;
  readonly usage: Readonly<Record<string, number>>;
}): Response {
  return anthropicEvents([
    { message: { usage: options.usage }, type: "message_start" },
    {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { text: options.text, type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    },
    { index: 0, type: "content_block_stop" },
    {
      delta: { stop_reason: options.stopReason },
      type: "message_delta",
      usage: { output_tokens: options.text.length },
    },
    { type: "message_stop" },
  ]);
}

export function doneAnthropicEvents(): Response {
  return textStopAnthropicEvents({
    stopReason: "end_turn",
    text: "Done.",
    usage: {
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 900,
      input_tokens: 60,
    },
  });
}

export interface AnthropicHarness {
  readonly complete: (
    messages?: Parameters<ChatCompletionsAgentModel["complete"]>[0],
  ) => ReturnType<ChatCompletionsAgentModel["complete"]>;
  readonly requestBody: (index: number) => Promise<unknown>;
  readonly requests: Request[];
}

export function anthropicHarness(
  responses: readonly Response[],
  options: Partial<AnthropicModelOptions> = {},
): AnthropicHarness {
  const requests: Request[] = [];
  const remaining = [...responses];
  const model = new ChatCompletionsAgentModel({
    credential: options.credential ?? ANTHROPIC_TEST_CREDENTIAL,
    credentialFingerprint:
      options.credentialFingerprint ?? ANTHROPIC_TEST_CREDENTIAL_FINGERPRINT,
    fetch: (request) => {
      requests.push(request);
      const response = remaining.shift();
      if (response === undefined) {
        throw new Error("No scripted response remains");
      }
      return Promise.resolve(response);
    },
    maxOutputTokens: null,
    model: KNOWN_ANTHROPIC_MODEL,
    provider: "generic",
    ...options,
  });
  return {
    complete: (messages = [{ content: "Hello", role: "user" }]) =>
      model.complete(messages),
    requestBody: async (index) => {
      const body: unknown = await requests[index]?.json();
      return body;
    },
    requests,
  };
}
