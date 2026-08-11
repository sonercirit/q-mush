import type { ProviderViewState } from "../provider-credential-model.ts";
import type { RunnerViewState } from "../runner-client.tsx";
import type { SessionViewState } from "../session-client.tsx";
import { renderSessionPanel } from "./render-session-panel.ts";
import { sessionClientTestState } from "./session-client-test-state.ts";
import {
  composerTestResources,
  type ComposerTestResources,
} from "./session-composer-fixtures.ts";

export interface SessionPanelTestContext extends ComposerTestResources {
  readonly state: SessionViewState;
}

function sessionPanelTestContext(): SessionPanelTestContext {
  return { ...composerTestResources(), state: sessionClientTestState() };
}

export const SESSION_PANEL_TEST_CONTEXT = sessionPanelTestContext();

export function renderSessionPanelWithResources(
  context: SessionPanelTestContext,
  state: SessionViewState,
  runners: RunnerViewState = context.runners,
  openAi: ProviderViewState = context.openAi,
  openRouter: ProviderViewState = context.emptyProvider,
): string {
  return renderSessionPanel(state, { openAi, openRouter, runners });
}

export function renderSessionPanelForTest(
  context: SessionPanelTestContext,
  state: SessionViewState,
): string {
  return renderSessionPanelWithResources(context, state);
}
