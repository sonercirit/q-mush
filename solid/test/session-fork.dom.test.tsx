import { expect, test, vi } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import { mountTestView } from "./dom-test-helpers.ts";
import { testSessionCredentialOption } from "./session-credential-fixtures.ts";
import { transcriptTestMessage } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const ForkDetail = SessionDetail;

function forkDisposals(): (() => void)[] {
  return [];
}

function disposeForkTest(disposals: readonly (() => void)[]): void {
  for (const dispose of disposals) {
    dispose();
  }
}

function selectedForkState(
  detail: typeof TEST_SESSION_DETAIL,
  values: Partial<SessionViewState> = {},
) {
  return createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    ...values,
    detail,
    selectedId: detail.id,
    sessions: [summaryFromDetail(detail)],
  });
}

test("fork transcript controls report the selected message", () => {
  const disposals = forkDisposals();
  const onFork = vi.fn();
  const container = mountTestView(
    () => (
      <ul>
        <SessionTranscript
          agentFile={null}
          executionEnvironment="bare_metal"
          filters={DEFAULT_SESSION_TRANSCRIPT_FILTERS}
          messages={[
            transcriptTestMessage("user-1", "Request", "user", 1),
            transcriptTestMessage("assistant-1", "Response", "assistant", 2),
          ]}
          onFork={onFork}
          tools={[]}
        />
      </ul>
    ),
    disposals,
  );

  const button = container.querySelector<HTMLButtonElement>(
    '[data-fork-from-here="assistant-1"]',
  );
  button?.click();

  expect(button?.textContent).toContain("Fork from here");
  expect(onFork).toHaveBeenCalledWith("assistant-1");
  disposeForkTest(disposals);
});

test("fork editor warns only after choosing a different provider or model", async () => {
  const detail = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptTestMessage("message-1", "Fork point", "assistant", 1),
    ],
  };
  const reactive = selectedForkState(detail);
  const controller = new SessionController(reactive, undefined, null, {
    command: (operation) =>
      Promise.resolve(
        operation === "sessions.models"
          ? {
              defaultModel: detail.model,
              models: [
                {
                  contextWindow: 128_000,
                  id: detail.model,
                  inputModalities: ["text"],
                  label: "Source model",
                  outputModalities: ["text"],
                  pricing: null,
                  reasoningEfforts: [],
                },
                {
                  contextWindow: 128_000,
                  id: "different-model",
                  inputModalities: ["text"],
                  label: "Different model",
                  outputModalities: ["text"],
                  pricing: null,
                  reasoningEfforts: ["high"],
                },
              ],
            }
          : detail,
      ),
  });
  const fork = vi.spyOn(controller, "fork").mockResolvedValue();
  const disposals = forkDisposals();
  const container = mountTestView(
    () => (
      <ForkDetail
        controller={controller}
        credentialAvailable
        credentials={[
          testSessionCredentialOption({
            id: detail.credentialId,
            isDefault: true,
            label: "Source credential",
            provider: detail.provider,
          }),
        ]}
        onOpenDirectoryPicker={vi.fn()}
        runners={[]}
        state={reactive.state()}
      />
    ),
    disposals,
  );

  container
    .querySelector<HTMLButtonElement>('[data-fork-from-here="message-1"]')
    ?.click();
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Fork session");
  });
  expect(container.textContent).not.toContain("compacted");
  await vi.waitFor(() => {
    container.querySelector<HTMLButtonElement>("#session-fork-model")?.click();
    expect(
      container.querySelector('[data-option-value="different-model"]'),
    ).not.toBeNull();
  });

  container
    .querySelector<HTMLButtonElement>('[data-option-value="different-model"]')
    ?.click();

  expect(container.textContent).toContain("compacted");
  container
    .querySelector<HTMLButtonElement>('[data-session-fork-submit="true"]')
    ?.click();
  await vi.waitFor(() => {
    expect(fork).toHaveBeenCalledWith(
      "message-1",
      expect.objectContaining({ model: "different-model" }),
    );
  });
  disposeForkTest(disposals);
});

test("historical transcript pages do not offer fork controls", () => {
  const onFork = vi.fn();
  const disposals = forkDisposals();
  disposals.push(() => onFork.mockClear());
  const current = transcriptTestMessage("current-1", "Current", "user", 2);
  const historical = transcriptTestMessage(
    "historical-1",
    "Historical",
    "user",
    1,
  );
  const detail = { ...TEST_SESSION_DETAIL, messages: [current] };
  const reactive = selectedForkState(detail, {
    history: {
      canGoOlder: false,
      error: undefined,
      loading: false,
      page: {
        currentSegment: 1,
        messages: [historical],
        newerCursor: null,
        olderCursor: null,
        segment: 0,
        sessionId: detail.id,
      },
    },
  });
  const controller = new SessionController(reactive, undefined, null);
  vi.spyOn(controller, "fork").mockImplementation((messageId) => {
    onFork(messageId);
    return Promise.resolve();
  });
  const container = mountTestView(
    () =>
      ForkDetail({
        controller,
        credentialAvailable: true,
        credentials: [],
        onOpenDirectoryPicker: vi.fn(),
        runners: [],
        state: reactive.state(),
      }),
    disposals,
  );

  container
    .querySelector<HTMLButtonElement>('[data-fork-from-here="historical-1"]')
    ?.click();

  expect(container.textContent).toContain("Historical");
  expect(container.textContent).not.toContain("Current");
  expect(container.querySelector("[data-fork-from-here]")).toBeNull();
  expect(onFork).not.toHaveBeenCalled();
  disposeForkTest(disposals);
});
