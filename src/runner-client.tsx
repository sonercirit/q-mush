import { isRecord, readNullableString } from "./auth-model.ts";
import * as clientControls from "./client-controls.tsx";
import { createElement, type JsxNode } from "./jsx.ts";
import type { RunnerStatus, RunnerSummary } from "./runner-model.ts";

export interface RunnerSetupInstructions {
  readonly command: string;
  readonly downloadUrl: string;
  readonly runnerId: string;
}

export interface RunnerViewState {
  readonly copied: boolean;
  readonly creating: boolean;
  readonly error: string | undefined;
  readonly removingId: string | undefined;
  readonly runners: readonly RunnerSummary[] | undefined;
  readonly setup: RunnerSetupInstructions | undefined;
}

export interface CreatedRunnerSetup {
  readonly runner: RunnerSummary;
  readonly setup: RunnerSetupInstructions;
}

const STATUS_PRESENTATION: Readonly<
  Record<RunnerStatus, { readonly classes: string; readonly label: string }>
> = {
  offline: {
    classes: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    label: "Offline",
  },
  online: {
    classes: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
    label: "Online",
  },
  pending: {
    classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    label: "Setup pending",
  },
};

function readRunner(value: unknown): RunnerSummary {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid runner");
  }

  const architecture = readNullableString(value["architecture"]);
  const id = value["id"];
  const lastSeenAt = value["lastSeenAt"];
  const name = readNullableString(value["name"]);
  const platform = readNullableString(value["platform"]);
  const status = value["status"];

  if (
    architecture === undefined ||
    typeof id !== "string" ||
    (lastSeenAt !== null &&
      (typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt))) ||
    name === undefined ||
    platform === undefined ||
    (status !== "offline" && status !== "online" && status !== "pending")
  ) {
    throw new Error("The server returned an invalid runner");
  }

  return { architecture, id, lastSeenAt, name, platform, status };
}

export function readRunners(value: unknown): readonly RunnerSummary[] {
  if (!isRecord(value) || !Array.isArray(value["runners"])) {
    throw new Error("The server returned an invalid runner list");
  }

  return value["runners"].map(readRunner);
}

export function readCreatedRunner(value: unknown): CreatedRunnerSetup {
  if (!isRecord(value) || !isRecord(value["setup"])) {
    throw new Error("The server returned invalid runner setup instructions");
  }

  const runner = readRunner(value["runner"]);
  const command = value["setup"]["command"];
  const downloadUrl = value["setup"]["downloadUrl"];

  if (typeof command !== "string" || typeof downloadUrl !== "string") {
    throw new Error("The server returned invalid runner setup instructions");
  }

  return {
    runner,
    setup: { command, downloadUrl, runnerId: runner.id },
  };
}

function platformLabel(value: string): string {
  switch (value) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return value;
  }
}

function runnerDetails(runner: RunnerSummary): string {
  if (runner.platform === null || runner.architecture === null) {
    return "Waiting for this computer to connect";
  }

  return `${platformLabel(runner.platform)} · ${runner.architecture}`;
}

function runnerActivity(runner: RunnerSummary): string {
  if (runner.status === "pending") {
    return "Run this setup's installer on one computer.";
  }

  if (runner.status === "online") {
    return "Connected now";
  }

  return runner.lastSeenAt === null
    ? "Not connected yet"
    : `Last connected ${new Date(runner.lastSeenAt).toLocaleString()}`;
}

function renderRunner(
  runner: RunnerSummary,
  removingId: string | undefined,
): JsxNode {
  const presentation = STATUS_PRESENTATION[runner.status];
  const removing = removingId === runner.id;

  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-slate-900 text-lg"
        >
          ◈
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-semibold text-white">
              {runner.name ?? "New runner"}
            </p>
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
            >
              {presentation.label}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-400">{runnerDetails(runner)}</p>
          <p className="mt-1 text-xs text-slate-500">
            {runnerActivity(runner)}
          </p>
        </div>
      </div>
      {clientControls.renderRemovalButton({
        action: "remove-runner",
        dataAttribute: "data-runner-id",
        id: runner.id,
        pending: removing,
      })}
    </li>
  );
}

function renderSetup(state: RunnerViewState): JsxNode {
  if (state.setup === undefined) {
    return null;
  }

  return (
    <div className="mt-7 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.08] p-5 sm:p-6">
      <p className="text-sm font-medium text-emerald-200">
        Install on one computer
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-300">
        Paste this one line into a macOS or Linux terminal. It downloads the
        runner, starts it in the background, and connects it to your account.
      </p>
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950 p-3">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm text-emerald-200">
          {state.setup.command}
        </code>
        <button
          className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:border-emerald-300/40"
          data-action="copy-runner-command"
          type="button"
        >
          {state.copied ? "Copied" : "Copy"}
        </button>
      </div>
      <a
        className="mt-4 inline-flex items-center justify-center rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-300/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        download="q-mush-runner-install.sh"
        href={state.setup.downloadUrl}
      >
        Download installer
      </a>
      <p className="mt-4 text-xs leading-5 text-slate-500">
        This command connects to the address currently open in your browser. A
        localhost address works only on this computer. Keep the command private;
        its token connects the runner back to your Q Mush user.
      </p>
    </div>
  );
}

function renderRunnerList(state: RunnerViewState): JsxNode {
  if (state.runners === undefined) {
    return state.error === undefined ? (
      <p className="mt-7 text-sm text-slate-400" role="status">
        Loading runners…
      </p>
    ) : null;
  }

  if (state.runners.length === 0) {
    return (
      <div className="mt-7 rounded-2xl border border-dashed border-white/15 p-6 text-sm leading-6 text-slate-400">
        No runners yet. Set up one on every computer where you want Q Mush to
        run agents.
      </div>
    );
  }

  return (
    <ul className="mt-7 space-y-3">
      {state.runners.map((runner) => renderRunner(runner, state.removingId))}
    </ul>
  );
}

export function renderRunnerPanel(state: RunnerViewState): JsxNode {
  return (
    <section
      aria-labelledby="runners-title"
      className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      data-runner-panel="true"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">
            Distributed runtime
          </p>
          <h2
            className="mt-2 text-2xl font-semibold text-white"
            id="runners-title"
          >
            Runners
          </h2>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            Add as many computers as you want. Install exactly one runner per
            computer; each one connects securely back to your user.
          </p>
        </div>
        <button
          className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          data-action="create-runner"
          disabled={state.creating}
          type="button"
        >
          {state.creating ? "Preparing…" : "Set up a runner"}
        </button>
      </div>

      {renderSetup(state)}
      {clientControls.renderRetryError(state.error, "retry-runners")}
      {renderRunnerList(state)}
    </section>
  );
}
