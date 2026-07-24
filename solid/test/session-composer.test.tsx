import { expect, test } from "vitest";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionStateWithMessages } from "./session-client-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  renderSessionPanelForTest,
  renderSessionPanelWithResources,
  SESSION_PANEL_TEST_CONTEXT,
} from "./session-panel-test-context.ts";

const PANEL_CONTEXT = SESSION_PANEL_TEST_CONTEXT;
const SESSION_STATE = PANEL_CONTEXT.state;
const EMPTY_PROVIDER_STATE = PANEL_CONTEXT.emptyProvider;
const OPENAI_STATE = PANEL_CONTEXT.openAi;
const RUNNER_STATE = PANEL_CONTEXT.runners;

function renderPanelWithProviders(
  state: SessionViewState,
  runnerState = RUNNER_STATE,
  openAiState = OPENAI_STATE,
): string {
  return renderSessionPanelWithResources(
    PANEL_CONTEXT,
    state,
    runnerState,
    openAiState,
  );
}

function offlineRunnerState() {
  return runnerViewState([{ ...runnerSummary(1), status: "offline" }]);
}

function renderPanel(state: SessionViewState): string {
  return renderSessionPanelForTest(SESSION_PANEL_TEST_CONTEXT, state);
}

function expectComposer(html: string, reason?: string): void {
  expect(html).toContain('data-session-composer="true"');
  if (reason !== undefined) {
    expect(html).toContain(reason);
  }
}

function expectUnavailableComposer(html: string, reason: string): void {
  expectComposer(html, reason);
  expect(html).toMatch(/<textarea[^>]*aria-disabled="true"/u);
}

function expectContinueDisabled(html: string): void {
  expect(html).toMatch(
    /<button[^>]*disabled[^>]*>Continue without message<\/button>/u,
  );
}

function panelState(
  detail: SessionViewState["detail"],
  extra: Partial<SessionViewState> = {},
): SessionViewState {
  return {
    ...sessionStateWithMessages(SESSION_STATE, []),
    detail,
    ...extra,
  };
}

test.each([
  {
    label: "Follow up",
    reason:
      "Queued. Follow up starts after the queued work; steering is available only while running.",
    status: "queued",
  },
  {
    label: "Follow up",
    reason:
      "Running. Follow up starts the next turn; Steer changes direction at the next safe model boundary.",
    status: "running",
  },
] as const)(
  "keeps the composer visible and available for a $status session",
  ({ label, status, reason }) => {
    const html = renderPanel(
      panelState(
        { ...TEST_SESSION_DETAIL, status },
        { followUp: "Keep this draft" },
      ),
    );

    expectComposer(html, reason);
    expect(html).toContain('name="prompt"');
    expect(html).toContain("Keep this draft");
    expect(html).toMatch(
      /<textarea[^>]*aria-disabled="false"[^>]*aria-describedby="session-composer-state"|<textarea[^>]*aria-describedby="session-composer-state"[^>]*aria-disabled="false"/u,
    );
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*>[\\s\\S]*?<span>${label}</span>[\\s\\S]*?<kbd`,
        "u",
      ),
    );
    expect(html).toContain(">Stop session</button>");
    expect(html).not.toContain(">Continue without message</button>");
    if (status === "queued") {
      expect(html).toMatch(
        /<button[^>]*disabled[^>]*>[\s\S]*?<span>Steer<\/span>[\s\S]*?<kbd/u,
      );
    } else {
      expect(html).toMatch(
        /<button[^>]*>[\s\S]*?<span>Steer<\/span>[\s\S]*?<kbd/u,
      );
    }
  },
);

test.each([
  { compacting: false, status: "idle" },
  { compacting: false, status: "failed" },
  { compacting: false, status: "stopped" },
] as const)(
  "keeps send and continue-without-message available for a $status session",
  ({ status }) => {
    const html = renderPanel(panelState({ ...TEST_SESSION_DETAIL, status }));

    expectComposer(html);
    expect(html).toMatch(/<textarea[^>]*name="prompt"(?![^>]*disabled)/u);
    expect(html).not.toMatch(/<textarea[^>]*\sreadonly(?:=|\s|>)/iu);
    expect(html).toMatch(/<button[^>]*>[\s\S]*?<span>Send<\/span>/u);
    expect(html).toContain(">Continue without message</button>");
    expect(html).not.toContain(">Stop session</button>");
  },
);

test("waits only for the selected provider when checking credentials", () => {
  const loadingProvider = providerViewState(undefined);
  const state = sessionStateWithMessages(SESSION_STATE, []);
  const availableHtml = renderSessionPanelWithResources(
    PANEL_CONTEXT,
    state,
    RUNNER_STATE,
    OPENAI_STATE,
    loadingProvider,
  );
  const loadingSelectedProviderHtml = renderSessionPanelWithResources(
    PANEL_CONTEXT,
    state,
    RUNNER_STATE,
    loadingProvider,
    EMPTY_PROVIDER_STATE,
  );

  expect(availableHtml).toContain("Ready for another instruction.");
  expect(availableHtml).toMatch(/<textarea[^>]*aria-disabled="false"/u);
  expect(loadingSelectedProviderHtml).toContain(
    "Checking whether the session credential is available…",
  );
  expectUnavailableComposer(
    loadingSelectedProviderHtml,
    "Checking whether the session credential is available…",
  );
});

test("disables an eligible composer when its runner or credential is unavailable", () => {
  const state = sessionStateWithMessages(SESSION_STATE, []);
  const unavailable = [
    [
      renderPanelWithProviders(state, offlineRunnerState()),
      "The session runner is offline or unavailable.",
    ],
    [
      renderPanelWithProviders(state, RUNNER_STATE, EMPTY_PROVIDER_STATE),
      "The session credential is unavailable.",
    ],
    [
      renderPanelWithProviders(state, {
        ...RUNNER_STATE,
        error: "Runner list failed",
        runners: undefined,
      }),
      "The session runner is offline or unavailable.",
    ],
    [
      renderPanelWithProviders(state, RUNNER_STATE, {
        ...OPENAI_STATE,
        credentials: undefined,
        error: "Credential list failed",
      }),
      "The session credential is unavailable.",
    ],
  ] as const;

  for (const [html, reason] of unavailable) {
    expectUnavailableComposer(html, reason);
  }
});

test.each([
  {
    reason:
      "The failed session cannot resume because its runner is offline or unavailable.",
    resource: "runner",
    status: "failed",
  },
  {
    reason:
      "The stopped session cannot resume because its credential is unavailable.",
    resource: "credential",
    status: "stopped",
  },
] as const)(
  "explains why a $status session cannot resume without its $resource",
  ({ reason, resource, status }) => {
    const state = panelState({ ...TEST_SESSION_DETAIL, status });
    const html =
      resource === "runner"
        ? renderPanelWithProviders(state, offlineRunnerState())
        : renderPanelWithProviders(state, RUNNER_STATE, EMPTY_PROVIDER_STATE);

    expectUnavailableComposer(html, reason);
    expectContinueDisabled(html);
  },
);
test.each([
  { mutation: { sending: true }, operation: "sending", reason: "Sending…" },
  {
    mutation: { stopping: true },
    operation: "stopping",
    reason: "Stopping…",
  },
  {
    mutation: { compacting: true },
    operation: "compacting",
    reason: "Compacting…",
  },
] as const)(
  "disables duplicate composer actions while $operation",
  ({ mutation, reason }) => {
    const html = renderPanel(panelState(TEST_SESSION_DETAIL, { ...mutation }));

    expectUnavailableComposer(html, reason);
    expectContinueDisabled(html);
  },
);
