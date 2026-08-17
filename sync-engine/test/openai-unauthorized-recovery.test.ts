import { describe, expect, test, vi, type MockInstance } from "vitest";
import type { AgentModelStep } from "../../shared/agent-loop.ts";
import {
  ChatCompletionsAgentModel,
  type AgentProviderCredential,
} from "../../sync-engine/agent-model.ts";
import { ProviderCredentialReauthenticationRequiredError } from "../../sync-engine/provider-error.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { codexOAuthCredential } from "./prompt-cache-fixtures.ts";
import {
  COMPLETED_EVENT,
  FakeProviderSockets,
  OPENAI_AUTHENTICATION_ERROR_EVENT,
  openAndRejectProviderSocket,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

const USER_MESSAGE = [{ content: "Hello", role: "user" as const }];

function refreshedCredential(): AgentProviderCredential {
  return {
    ...codexOAuthCredential(),
    secret: JSON.stringify({
      access: "refreshed-access-token",
      expires: 1_800_000_000_000,
      refresh: "refreshed-refresh-token",
    }),
  };
}

function successfulRefresh(
  credential: AgentProviderCredential,
): Promise<AgentProviderCredential> {
  return Promise.resolve({ ...credential, ...refreshedCredential() });
}

function optionalDelta(
  onDelta: ((delta: ProviderTextDelta) => void) | undefined,
): { readonly onDelta?: (delta: ProviderTextDelta) => void } {
  return onDelta === undefined ? {} : { onDelta };
}

function model(options: {
  readonly credential?: AgentProviderCredential;
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly refreshCredential?: (
    rejectedCredential: AgentProviderCredential,
  ) => Promise<AgentProviderCredential>;
  readonly sockets: FakeProviderSockets;
}): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: options.credential ?? codexOAuthCredential(),
    fetch: unexpectedHttpFallback,
    ...optionalDelta(options.onDelta),
    ...(options.refreshCredential === undefined
      ? {}
      : { refreshCredential: options.refreshCredential }),
    sleep: () => Promise.resolve(),
    ...openAiModelOptions("gpt-5-codex"),
    webSocket: options.sockets.create,
  });
}

function unexpectedHttpFallback(): Promise<Response> {
  return Promise.reject(new Error("HTTP fallback was unexpected"));
}

function genericUnauthorizedModel(
  refreshCredential: (
    credential: AgentProviderCredential,
  ) => Promise<AgentProviderCredential>,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: {
      ...codexOAuthCredential(),
      baseUrl: "https://example.test/v1",
    },
    fetch: () =>
      Promise.resolve(Response.json({ error: "revoked" }, { status: 401 })),
    refreshCredential,
    ...openAiModelOptions("other-model", "generic"),
  });
}

function openAiModelOptions(
  model: string,
  provider: "generic" | "openai" = "openai",
) {
  return { maxOutputTokens: null, model, provider } as const;
}

function refreshSetup(
  credential: AgentProviderCredential = codexOAuthCredential(),
): {
  readonly pending: Promise<AgentModelStep>;
  readonly refreshCredential: MockInstance<
    (credential: AgentProviderCredential) => Promise<AgentProviderCredential>
  >;
  readonly sockets: FakeProviderSockets;
} {
  const sockets = new FakeProviderSockets();
  const refreshCredential = vi.fn(successfulRefresh);
  const pending = model({ credential, refreshCredential, sockets }).complete(
    USER_MESSAGE,
  );
  return { pending, refreshCredential, sockets };
}

function completeSuccessfulRetry(
  sockets: FakeProviderSockets,
  index = 1,
): void {
  const retry = requireProviderSocket(sockets, index);
  retry.open();
  retry.receive(COMPLETED_EVENT);
}

function expectUnauthorized(
  pending: Promise<AgentModelStep>,
): PromiseLike<unknown> {
  return expect(pending).rejects.toMatchObject({ authenticationFailure: true });
}

function rejectSocket(
  setup: ReturnType<typeof refreshSetup>,
  index: number,
): Promise<unknown> {
  return openAndRejectProviderSocket(setup.sockets, index);
}

function expectRefreshAttemptCount(
  setup: ReturnType<typeof refreshSetup>,
  count: number,
): void {
  expect(setup.refreshCredential).toHaveBeenCalledTimes(count);
  expect(setup.sockets.created).toHaveLength(count + 1);
}

describe("OpenAI OAuth unauthorized recovery", () => {
  test("forces one refresh and retries a 401 with the refreshed token", async () => {
    const setup = refreshSetup();

    await openAndRejectProviderSocket(setup.sockets, 0);

    await setup.sockets.waitForAttempt(1);
    const retry = requireProviderSocket(setup.sockets, 1);
    expect(setup.refreshCredential).toHaveBeenCalledOnce();
    const rejectedCredential = setup.refreshCredential.mock.calls[0]?.[0];
    expect(rejectedCredential?.secret).toContain("oauth-access-token");
    expect(retry.headers["authorization"]).toBe(
      "Bearer refreshed-access-token",
    );
    retry.open();
    retry.receive(COMPLETED_EVENT);

    expectDoneStep(await setup.pending);
  });

  test("forces one refresh for a documented no-status WebSocket authentication event", async () => {
    const setup = refreshSetup();
    const rejected = requireProviderSocket(setup.sockets, 0);
    rejected.open();
    rejected.receive(OPENAI_AUTHENTICATION_ERROR_EVENT);

    await setup.sockets.waitForAttempt(1);
    completeSuccessfulRetry(setup.sockets);

    expectDoneStep(await setup.pending);
    expectRefreshAttemptCount(setup, 1);
  });

  test("clears partial output before retrying with the refreshed token", async () => {
    const deltas: ProviderTextDelta[] = [];
    const sockets = new FakeProviderSockets();
    const pending = model({
      onDelta: (delta) => deltas.push(delta),
      refreshCredential: successfulRefresh,
      sockets,
    }).complete(USER_MESSAGE);
    const rejected = requireProviderSocket(sockets, 0);
    rejected.open();
    rejected.receive({
      delta: "Discarded partial output.",
      type: "response.output_text.delta",
    });
    rejected.receive(OPENAI_AUTHENTICATION_ERROR_EVENT);

    await sockets.waitForAttempt(1);
    completeSuccessfulRetry(sockets);

    expectDoneStep(await pending);
    expect(deltas).toEqual([
      { content: "Discarded partial output.", thinking: "" },
      { content: "", reset: true, thinking: "" },
    ]);
  });

  test("does not refresh twice when the retried request is also unauthorized", async () => {
    const setup = refreshSetup();

    await rejectSocket(setup, 0);
    await rejectSocket(setup, 1);

    await expectUnauthorized(setup.pending);
    expectRefreshAttemptCount(setup, 1);
  });

  test("does not force OAuth refresh for an API key 401", async () => {
    const setup = refreshSetup({
      accountId: null,
      secret: "sk-openai-api-key",
      source: "api_key",
    });

    await rejectSocket(setup, 0);

    await expectUnauthorized(setup.pending);
    expectRefreshAttemptCount(setup, 0);
  });

  test("does not recover a non-OpenAI 401 even when passed a refresher", async () => {
    const refreshCredential = vi.fn(successfulRefresh);
    const pending =
      genericUnauthorizedModel(refreshCredential).complete(USER_MESSAGE);

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(refreshCredential).not.toHaveBeenCalled();
  });

  test("surfaces a terminal refresh rejection as an explicit re-login error", async () => {
    const sockets = new FakeProviderSockets();
    const refreshCredential = vi.fn(() =>
      Promise.reject(
        new ProviderCredentialReauthenticationRequiredError("OpenAI", 401),
      ),
    );
    const pending = model({ refreshCredential, sockets }).complete(
      USER_MESSAGE,
    );

    await openAndRejectProviderSocket(sockets, 0);

    await expect(pending).rejects.toThrow(
      "OpenAI login has expired. Connect the account again to continue.",
    );
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(sockets.created).toHaveLength(1);
  });
});
