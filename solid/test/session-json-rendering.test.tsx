import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import { createDisplaySessionMessage } from "../../solid/session-message.ts";
import { SessionPendingInputs } from "../../solid/session-pending-client.tsx";
import {
  renderHighlightedCode,
  renderStructuredCode,
} from "../../solid/session-syntax.tsx";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../../solid/session-transcript-filters.ts";
import { SessionTranscript } from "../../solid/session-transcript.tsx";
import { renderSolidToString } from "./render-solid.tsx";
import { testToolStream } from "./session-tool-stream-fixtures.ts";

const RICH_JSON_VALUE =
  "first line  \nsecond line\n\n## Heading\n- item\n\n**bold**";
const ENCODED_RICH_JSON_VALUE = JSON.stringify(RICH_JSON_VALUE);

function renderSyntax(
  render: () => ReturnType<typeof renderStructuredCode>,
): string {
  return renderSolidToString(render);
}

function message(options: {
  readonly content: string;
  readonly id: string;
  readonly role: AgentSessionMessage["role"];
  readonly toolArguments?: string;
}): AgentSessionMessage {
  const base = createDisplaySessionMessage({
    content: options.content,
    createdAt: 1,
    id: options.id,
    role: options.role,
  });
  return options.toolArguments === undefined
    ? base
    : {
        ...base,
        toolCalls: [
          {
            arguments: options.toolArguments,
            id: `call-${options.id}`,
            name: "bash",
          },
        ],
      };
}

function renderTestTranscript(
  messages: readonly AgentSessionMessage[],
  toolStreams: readonly ToolStreamEntry[],
): string {
  return renderSolidToString(() => (
    <SessionTranscript
      agentFile={null}
      executionEnvironment="bare_metal"
      filters={DEFAULT_SESSION_TRANSCRIPT_FILTERS}
      messages={messages}
      toolStreams={toolStreams}
      tools={[]}
    />
  ));
}

function toolStream(argumentsContent: string) {
  return testToolStream("live-call", argumentsContent, "bash", {
    stdout: "",
  });
}

function expectRichJsonValue(html: string): void {
  expect(html).toContain('data-language="json"');
  expect(html).toContain(
    '<span class="text-cyan-300">"prompt"</span>: <span class="text-emerald-300">"</span>',
  );
  expect(html).toContain(
    '<p class="whitespace-pre-wrap">first line  \nsecond line</p>',
  );
  expect(html).not.toContain("first line  \\nsecond line");
  expect(html).toContain(">Heading</h2>");
  expect(html).toContain('<ul class="list-disc space-y-1 pl-5">');
  expect(html).toContain(">item");
  expect(html).toContain(">bold</strong>");
}

function expectPropertyToken(
  html: string,
  property: string,
  valueClass: string,
  value: string,
): void {
  expect(html).toContain(
    `<span class="text-cyan-300">"${property}"</span>: <span class="${valueClass}">${value}</span>`,
  );
}

test("pretty-prints and colorizes complete JSON", () => {
  const html = renderSyntax(() =>
    renderStructuredCode('{"name":"Q Mush","ready":true}'),
  );

  expect(html).toContain('data-language="json"');
  expectPropertyToken(html, "name", "text-emerald-300", '"Q Mush"');
  expectPropertyToken(html, "ready", "text-violet-300", "true");
});

test("renders complete JSON string newlines and embedded markdown", () => {
  const html = renderSyntax(() =>
    renderStructuredCode(`{"prompt":${ENCODED_RICH_JSON_VALUE}}`),
  );

  expectRichJsonValue(html);
  expect(html).toContain('<span class="text-emerald-300">"</span>');
  expect(html).toContain("}</code></pre>");
});

test("renders markdown-only JSON string values richly", () => {
  const html = renderSyntax(() =>
    renderStructuredCode('{"note":"**important**"}'),
  );

  expect(html).toContain(">important</strong>");
  expect(html).not.toContain('>"**important**"</span>');
});

test("renders streaming JSON string newlines and embedded markdown", () => {
  const partial = `{"prompt":${ENCODED_RICH_JSON_VALUE.slice(0, -1)}`;
  const html = renderSyntax(() => renderHighlightedCode(partial, "json"));

  expectRichJsonValue(html);
});

test("pretty-prints and colorizes a streaming JSON prefix", () => {
  const html = renderSyntax(() =>
    renderHighlightedCode('{"key":"unterminated', "json"),
  );

  expect(html).toContain('data-language="json"');
  expect(html).toContain(
    '{\n  <span class="text-cyan-300">"key"</span>: <span class="text-emerald-300">"unterminated</span>',
  );
  const partialNumber = renderSyntax(() =>
    renderStructuredCode('{"count":-12.3e'),
  );
  expect(partialNumber).toContain('<span class="text-amber-300">-12.3e</span>');
});

function expectSpawnedSessionText(html: string): void {
  expect(html).toContain("Spawned session completed:");
}

test("preserves surrounding text while formatting embedded JSON", () => {
  const html = renderSyntax(() =>
    renderStructuredCode(
      'Spawned session completed:\n{"status":"done","count":2}\nContinue.',
    ),
  );

  expectSpawnedSessionText(html);
  expect(html).toContain("Continue.");
  expect(html).toContain(
    '<span class="text-cyan-300">"status"</span>: <span class="text-emerald-300">"done"</span>',
  );
  expect(html).toContain(
    '<span class="text-cyan-300">"count"</span>: <span class="text-amber-300">2</span>',
  );
});

test("leaves non-JSON text unchanged and bounds arbitrary candidates", () => {
  const plain = "Use [brackets] and {braces} as prose.";
  expect(renderSyntax(() => renderStructuredCode(plain))).toContain(
    `>${plain}</pre>`,
  );
  const candidates = `${"{nope} ".repeat(70)}tail`;
  const renderedCandidates = renderSyntax(() =>
    renderStructuredCode(candidates),
  );
  expect(renderedCandidates).toContain("{nope}");
});

test("colorizes embedded JSON in queued instructions", () => {
  const html = renderSolidToString(() => (
    <SessionPendingInputs
      inputs={[
        {
          content: 'Spawned session completed:\n{"result":"ok"}',
          id: "queued-1",
          images: [],
          kind: "steer",
        },
      ]}
      onCancel={() => undefined}
    />
  ));

  expect(html).toContain("Queued steer");
  expectSpawnedSessionText(html);
  expect(html).toContain('data-language="json"');
  expect(html).toContain(
    '<span class="text-cyan-300">"result"</span>: <span class="text-emerald-300">"ok"</span>',
  );
});

test("colorizes mixed messages and partial settled and live tool arguments", () => {
  const html = renderTestTranscript(
    [
      message({
        content: 'Spawned session completed:\n{"answer":42}',
        id: "assistant-1",
        role: "assistant",
      }),
      message({
        content: "",
        id: "assistant-2",
        role: "assistant",
        toolArguments: '{"settled":"still streaming',
      }),
    ],
    [toolStream('{"live":fal')],
  );

  expectSpawnedSessionText(html);
  expect(html).toContain(
    '<span class="text-cyan-300">"answer"</span>: <span class="text-amber-300">42</span>',
  );
  expect(html).toContain(
    '<span class="text-cyan-300">"settled"</span>: <span class="text-emerald-300">"still streaming</span>',
  );
  expect(html).toContain(
    '<span class="text-cyan-300">"live"</span>: <span class="text-violet-300">fal</span>',
  );
});
