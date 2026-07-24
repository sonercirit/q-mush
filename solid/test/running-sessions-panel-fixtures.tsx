import { type JSX } from "solid-js";
import type { RunnerSummary } from "../../shared/runner-model.ts";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { RenderDebugProvider, type RenderDebugView } from "../render-debug.tsx";
import {
  RunningSessionsController,
  type RunningSessionsViewState,
} from "../running-sessions-controller.ts";
import { RunningSessionsPanel } from "../running-sessions-panel.tsx";
import { SessionClockProvider } from "../session-active-time.tsx";

function doNothing(): void {
  // Test default.
}

export function createRunningSessionsController(
  sessions: readonly AgentSessionSummary[],
  freshness: RunningSessionsViewState["freshness"] = "live",
): RunningSessionsController {
  const controller = new RunningSessionsController({
    freshness: "loading",
    overview: undefined,
  });
  controller.applySnapshot(sessions);
  if (freshness === "stale") {
    controller.connectionLost();
  }
  return controller;
}

export function runningSessionsController(
  state: RunningSessionsViewState,
): RunningSessionsController {
  return new RunningSessionsController(state);
}

export function TestRunningSessionsPanel(props: {
  readonly controller: RunningSessionsController;
  readonly debug?: RenderDebugView;
  readonly focusSessionList?: () => void;
  readonly runners?: readonly RunnerSummary[];
  readonly selectSession?: (sessionId: string) => void;
}): JSX.Element {
  const panel = () => (
    <RunningSessionsPanel
      controller={props.controller}
      focusSessionList={props.focusSessionList ?? doNothing}
      selectSession={props.selectSession ?? doNothing}
      runners={() => props.runners ?? []}
    />
  );
  return (
    <SessionClockProvider>
      {props.debug === undefined ? (
        panel()
      ) : (
        <RenderDebugProvider view={props.debug}>{panel()}</RenderDebugProvider>
      )}
    </SessionClockProvider>
  );
}
