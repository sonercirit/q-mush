import { Show, type JSX } from "solid-js";
import { reasoningEffortLabel } from "../shared/agent-configuration.ts";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionTime,
} from "../shared/session-timing.ts";
import { createLiveNow } from "./live-now.ts";

const STATUS_PRESENTATION: Readonly<
  Record<
    AgentSessionStatus,
    { readonly classes: string; readonly label: string }
  >
> = {
  completed: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Completed",
  },
  failed: {
    classes: "border-rose-300/20 bg-rose-300/10 text-rose-200",
    label: "Failed",
  },
  idle: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Ready",
  },
  paused: {
    classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
    label: "Restarting",
  },
  queued: {
    classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    label: "Queued",
  },
  running: {
    classes: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
    label: "Running",
  },
  stopped: {
    classes: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    label: "Stopped",
  },
};

export function statusBadge(
  session: Pick<
    AgentSessionSummary,
    "pendingQuestions" | "runnerRequired" | "status"
  >,
): JSX.Element {
  const presentation =
    session.pendingQuestions !== null
      ? {
          classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
          label: "Waiting for answers",
        }
      : session.runnerRequired
        ? {
            classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
            label: "Choose runner",
          }
        : STATUS_PRESENTATION[session.status];
  return (
    <span
      class={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      {presentation.label}
    </span>
  );
}

export function executionEnvironmentLabel(
  environment: AgentSessionSummary["executionEnvironment"],
): string {
  return environment === "container" ? "Container" : "Bare Metal";
}

export function sessionModelLabel(
  session: Pick<AgentSessionSummary, "model" | "provider" | "reasoningEffort">,
): string {
  const model = `${session.provider} · ${session.model}`;
  return session.reasoningEffort === null
    ? model
    : `${model} · ${reasoningEffortLabel(session.reasoningEffort)} reasoning`;
}

function formatSessionCost(costUsd: number): string {
  if (costUsd === 0) {
    return "$0.00";
  }
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function sessionCostText(
  session: Pick<AgentSessionSummary, "costBasis" | "costUsd">,
): string {
  switch (session.costBasis) {
    case "estimated":
      return `Estimated cost: ${formatSessionCost(session.costUsd)}`;
    case "none":
      return "Cost: Not available";
    case "reported":
      return `Cost: ${formatSessionCost(session.costUsd)}`;
  }
}

function liveDuration(now: number, startedAt: number): string {
  return formatSessionTime(Math.max(0, now - startedAt));
}

function LiveDuration(props: {
  readonly kind: "run" | "step";
  readonly now: () => number;
  readonly startedAt: number | null;
}): JSX.Element {
  return (
    <Show when={props.startedAt} keyed>
      {(startedAt) => (
        <span
          class={
            props.kind === "run" ? "text-emerald-200" : "text-emerald-200/80"
          }
          data-session-run-duration={props.kind === "run" ? "true" : undefined}
          data-session-step-duration={
            props.kind === "step" ? "true" : undefined
          }
        >
          {`${props.kind === "run" ? "Run" : "Step"}: ${liveDuration(props.now(), startedAt)}`}
        </span>
      )}
    </Show>
  );
}

export function SessionMetrics(props: {
  readonly session: Pick<
    AgentSessionSummary,
    | "activeDurationMs"
    | "activeStartedAt"
    | "costBasis"
    | "costUsd"
    | "runtimePending"
    | "stepStartedAt"
  >;
}): JSX.Element {
  const now = createLiveNow(() => props.session.activeStartedAt !== null);

  return (
    <span class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      <span>
        {`Time: ${formatSessionTime(activeSessionDuration(props.session, now()))}`}
      </span>
      <LiveDuration
        kind="run"
        now={now}
        startedAt={props.session.activeStartedAt}
      />
      <LiveDuration
        kind="step"
        now={now}
        startedAt={
          props.session.activeStartedAt === null
            ? null
            : props.session.stepStartedAt
        }
      />
      <Show when={props.session.runtimePending} keyed>
        {(pending) => (
          <span class="text-amber-200/90" data-session-pending-component="true">
            {`Pending: ${pending.component.replaceAll("_", " ")}`}
          </span>
        )}
      </Show>
      <span>{sessionCostText(props.session)}</span>
    </span>
  );
}
