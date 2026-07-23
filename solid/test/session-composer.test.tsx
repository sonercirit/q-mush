import { expect, test } from "vitest";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { runnerViewState } from "./client-state-fixtures.ts";
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

function renderPanel(state: SessionViewState): string {
  return renderSessionPanelForTest(SESSION_PANEL_TEST_CONTEXT, state);
}

function expectComposer(html: string, reason?: string): void {
  expect(html).toContain('data-session-composer="true"');
  if (reason !== undefined) {
    expect(html).toContain(reason);
  }
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
    reason: "Session is queued. You can send when it is ready.",
    status: "queued",
  },
  {
    reason: "Session is running. You can send when it is ready.",
    status: "running",
  },
] as const)(
  "keeps the composer visible but unavailable while a session is $status",
  ({ status, reason }) => {
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
      /<textarea[^>]*aria-describedby="session-composer-state"[^>]*disabled/u,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/u);
    expect(html).toContain(">Stop session</button>");
    expect(html).not.toContain(">Continue</button>");
  },
);

test.each([
  { compacting: false, status: "idle" },
  { compacting: false, status: "failed" },
  { compacting: false, status: "stopped" },
] as const)(
  "keeps send and Continue available for a $status session",
  ({ status }) => {
    const html = renderPanel(panelState({ ...TEST_SESSION_DETAIL, status }));

    expectComposer(html);
    expect(html).toMatch(/<textarea[^>]*name="prompt"(?![^>]*disabled)/u);
    expect(html).toMatch(/<button[^>]*>Send<\/button>/u);
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain(">Stop session</button>");
  },
);

test("disables an eligible composer when its runner or credential is unavailable", () => {
  const state = sessionStateWithMessages(SESSION_STATE, []);
  const offlineHtml = renderPanelWithProviders(
    state,
    runnerViewState([{ ...runnerSummary(1), status: "offline" }]),
  );
  const missingCredentialHtml = renderPanelWithProviders(
    state,
    RUNNER_STATE,
    EMPTY_PROVIDER_STATE,
  );

  expect(offlineHtml).toContain(
    "The session runner is offline or unavailable.",
  );
  expect(offlineHtml).toMatch(/<textarea[^>]*disabled/u);
  expect(missingCredentialHtml).toContain(
    "The session credential is unavailable.",
  );
  expect(missingCredentialHtml).toMatch(/<textarea[^>]*disabled/u);
});

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

    expectComposer(html, reason);
    expect(html).toMatch(/<textarea[^>]*disabled/u);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Continue<\/button>/u);
  },
);
