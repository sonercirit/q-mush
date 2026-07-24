import { expect, test, vi } from "vitest";
import type { ProviderLimitObservation } from "../../shared/provider-limits.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";

const NOW = 1_700_000_000_000;
const PROMPT = [{ content: "Hello", role: "user" }] as const;
const DONE_CHAT = { choices: [{ message: { content: "Done." } }] };
const DONE_RESPONSE_EVENT = {
  response: { output: [] },
  type: "response.completed",
};

type ModelOptions = ConstructorParameters<typeof ChatCompletionsAgentModel>[0];

function completeWithLimits(
  options: Omit<ModelOptions, "now" | "onLimits">,
  observations: ProviderLimitObservation[],
) {
  const model = new ChatCompletionsAgentModel({
    ...options,
    now: () => NOW,
    onLimits: (observation) => observations.push(observation),
  });
  return model.complete(PROMPT);
}

function closingSocket() {
  const socket = new EventSocket();
  queueMicrotask(() => socket.dispatchEvent(new Event("close")));
  return socket;
}

test("captures OpenAI API limit headers from retried 429 and successful HTTP responses", async () => {
  const observations: ProviderLimitObservation[] = [];
  const responses = [
    new Response(null, {
      headers: {
        "retry-after": "2",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "0",
      },
      status: 429,
    }),
    Response.json(DONE_CHAT, {
      headers: {
        "x-provider-payload": "secret-provider-payload",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "900",
      },
    }),
  ];
  await completeWithLimits(
    {
      credential: { accountId: null, secret: "sk-secret", source: "api_key" },
      fetch: () =>
        Promise.resolve(responses.shift() ?? Response.json(DONE_CHAT)),
      model: "gpt-4.1-mini",
      provider: "openai",
      sleep: () => Promise.resolve(),
      webSocket: closingSocket,
    },
    observations,
  );

  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({
    dimensions: [{ key: "requests", limit: 100, remaining: 0 }],
  });
  expect(observations[1]).toMatchObject({
    dimensions: [{ key: "tokens", limit: 1000, remaining: 900 }],
  });
  expect(JSON.stringify(observations)).not.toContain("secret-provider-payload");
  expect(JSON.stringify(observations)).not.toContain("sk-secret");
});

test("captures OpenRouter platform-limit response headers", async () => {
  const observations: ProviderLimitObservation[] = [];
  await completeWithLimits(
    {
      credential: {
        accountId: null,
        secret: "sk-or-secret",
        source: "oauth",
      },
      fetch: () =>
        Promise.resolve(
          Response.json(DONE_CHAT, {
            headers: {
              "x-ratelimit-limit": "20",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700000060000",
            },
          }),
        ),
      model: "openai/gpt-4.1-mini",
      provider: "openrouter",
    },
    observations,
  );

  const observedProviderLimit = observations[0];
  expect(observedProviderLimit).toMatchObject({
    dimensions: [{ key: "provider_limit", limit: 20, remaining: 0 }],
    provider: "openrouter",
  });
});

class EventSocket extends EventTarget {
  readonly readyState = WebSocket.OPEN;

  close(): void {
    this.dispatchEvent(new CloseEvent("close"));
  }

  send(): void {
    const limits = {
      credits: { balance: "4", has_credits: true, unlimited: false },
      rate_limits: {
        primary: { used_percent: 80, window_minutes: 300 },
      },
      type: "codex.rate_limits",
    };
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(limits) }),
    );
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(DONE_RESPONSE_EVENT),
      }),
    );
  }
}

function codexOptions(
  fetch: NonNullable<ModelOptions["fetch"]>,
  webSocket: NonNullable<ModelOptions["webSocket"]>,
): Omit<ModelOptions, "now" | "onLimits"> {
  return {
    credential: {
      accountId: "account",
      secret: createOpenAiOAuthSecret(),
      source: "oauth",
    },
    fetch,
    model: "gpt-5-codex",
    provider: "openai",
    sleep: () => Promise.resolve(),
    webSocket,
  };
}

test("captures documented Codex WebSocket events without relying on upgrade headers", async () => {
  const observations: ProviderLimitObservation[] = [];
  let socket: EventSocket | undefined;
  await completeWithLimits(
    codexOptions(
      () => Promise.reject(new Error("HTTP must not run")),
      () => {
        socket = new EventSocket();
        queueMicrotask(() => socket?.dispatchEvent(new Event("open")));
        return socket;
      },
    ),
    observations,
  );

  expect(observations).toMatchObject([
    {
      dimensions: [
        { key: "codex_primary_5h", remaining: 20 },
        { key: "codex_credits", remaining: 4 },
      ],
      source: "websocket_event",
    },
  ]);
});

test("captures Codex HTTP fallback headers and events", async () => {
  const observations: ProviderLimitObservation[] = [];
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        `data: ${JSON.stringify({
          rate_limits: {
            secondary: { used_percent: 25, window_minutes: 10080 },
          },
          type: "codex.rate_limits",
        })}\n\ndata: ${JSON.stringify(DONE_RESPONSE_EVENT)}\n\n`,
        { headers: { "x-codex-primary-used-percent": "50" } },
      ),
    ),
  );
  await completeWithLimits(codexOptions(fetch, closingSocket), observations);

  expect(observations.map(({ source }) => source)).toEqual([
    "http_headers",
    "response_event",
  ]);
});
