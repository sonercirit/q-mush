import { Show, type Accessor, type JSX } from "solid-js";
import { isRecord, readNullableString } from "../shared/auth-model.ts";
import type { PendingViewState } from "../shared/connection-model.ts";
import type { RunnerStatus, RunnerSummary } from "../shared/runner-model.ts";
import type { WorkspaceList } from "../shared/workspace-model.ts";
import { Collection } from "./collection.tsx";
import {
  optionalWorkspaces,
  workspaceIdsAreValid,
} from "./connection-client.ts";
import { DefaultableActions } from "./defaultable-actions.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";
import { ScopedConnectionEditor } from "./scoped-connection-editor.tsx";

export interface RunnerSetupInstructions {
  readonly command: string;
  readonly downloadUrl: string;
  readonly runnerId: string;
}

export interface RunnerViewState extends PendingViewState {
  readonly copied: boolean;
  readonly runners: readonly RunnerSummary[] | undefined;
  readonly setup: RunnerSetupInstructions | undefined;
}

export function createRunnerViewState(
  runners: readonly RunnerSummary[] | undefined,
): RunnerViewState {
  return {
    copied: false,
    creating: false,
    error: undefined,
    removingId: undefined,
    runners,
    settingDefaultId: undefined,
    setup: undefined,
  };
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
  const isGlobal = value["isGlobal"];
  const lastSeenAt = value["lastSeenAt"];
  const name = readNullableString(value["name"]);
  const platform = readNullableString(value["platform"]);
  const status = value["status"];
  const workspaceIds = value["workspaceIds"];

  if (
    architecture === undefined ||
    typeof id !== "string" ||
    typeof value["isDefault"] !== "boolean" ||
    (isGlobal !== undefined && typeof isGlobal !== "boolean") ||
    (lastSeenAt !== null &&
      (typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt))) ||
    name === undefined ||
    platform === undefined ||
    (status !== "offline" && status !== "online" && status !== "pending") ||
    !workspaceIdsAreValid(workspaceIds)
  ) {
    throw new Error("The server returned an invalid runner");
  }

  return {
    architecture,
    id,
    isDefault: value["isDefault"],
    ...(isGlobal === undefined ? {} : { isGlobal }),
    lastSeenAt,
    name,
    platform,
    status,
    ...(workspaceIds === undefined
      ? {}
      : { workspaceIds: workspaceIds.map(String) }),
  };
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

interface RunnerItemProps {
  readonly controller: RunnerPanelController;
  readonly runner: RunnerSummary;
  readonly state: RunnerViewState;
  readonly workspaces?: Accessor<WorkspaceList | undefined>;
}

function RunnerActions(props: RunnerItemProps): JSX.Element {
  return (
    <DefaultableActions
      data={{ "data-runner-id": props.runner.id }}
      isDefault={props.runner.isDefault}
      onRemove={() => {
        void props.controller.remove(props.runner.id);
      }}
      onSetDefault={() => {
        void props.controller.setDefault(props.runner.id);
      }}
      removing={props.state.removingId === props.runner.id}
      settingDefault={props.state.settingDefaultId === props.runner.id}
    />
  );
}

function RunnerItem(props: RunnerItemProps): JSX.Element {
  const presentation = () => STATUS_PRESENTATION[props.runner.status];

  return (
    <li
      class="flex min-w-0 flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
      {...renderDebugBoundary(
        `runner:${props.runner.id}`,
        `Runner: ${props.runner.name ?? "New runner"}`,
      )}
    >
      <div class="flex min-w-0 items-start gap-4">
        <span
          aria-hidden="true"
          class="grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-slate-900 text-lg"
        >
          ◈
        </span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <p class="path-wrap font-semibold text-white">
              {props.runner.name ?? "New runner"}
            </p>
            <span
              class={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation().classes}`}
            >
              {presentation().label}
            </span>
          </div>
          <p class="path-wrap mt-2 text-sm text-slate-400">
            {runnerDetails(props.runner)}
          </p>
          <p class="path-wrap mt-1 text-xs text-slate-500">
            {runnerActivity(props.runner)}
          </p>
          <p class="mt-1 text-xs text-slate-500">
            {props.runner.isGlobal === true
              ? "Scope: Global"
              : `Scope: ${String(props.runner.workspaceIds?.length ?? 0)} workspace(s)`}
          </p>
          <ScopedConnectionEditor
            connection={props.runner}
            controller={props.controller}
            workspaces={props.workspaces}
          />
        </div>
      </div>
      <RunnerActions {...props} />
    </li>
  );
}

interface RunnerPanelProps {
  readonly controller: RunnerPanelController;
  readonly state: RunnerViewState;
}

function RunnerSetup(props: RunnerPanelProps): JSX.Element {
  return (
    <Show when={props.state.setup}>
      {(setup) => (
        <div class="mt-7 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.08] p-4 sm:p-6">
          <p class="text-sm font-medium text-emerald-200">
            Install on one computer
          </p>
          <p class="mt-2 text-sm leading-6 text-slate-300">
            Paste this one line into a macOS or Linux terminal. It downloads the
            runner, starts it in the background, and connects it to your
            account.
          </p>
          <div class="mt-4 flex min-w-0 flex-col gap-3 rounded-xl border border-white/10 bg-slate-950 p-3 sm:flex-row sm:items-center">
            <code class="path-wrap min-w-0 flex-1 text-sm text-emerald-200">
              {setup().command}
            </code>
            <button
              class="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:border-emerald-300/40"
              onClick={() => {
                void props.controller.copyCommand();
              }}
              type="button"
            >
              {props.state.copied ? "Copied" : "Copy"}
            </button>
          </div>
          <a
            class="mt-4 inline-flex items-center justify-center rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-300/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            download="q-mush-runner-install.sh"
            href={setup().downloadUrl}
          >
            Download installer
          </a>
          <p class="mt-4 text-xs leading-5 text-slate-500">
            This command connects to the address currently open in your browser.
            A localhost address works only on this computer. Keep the command
            private; its token connects the runner back to your Q Mush user.
          </p>
        </div>
      )}
    </Show>
  );
}

interface RunnerControllerProps {
  readonly controller: RunnerPanelController;
  readonly workspaces?: Accessor<WorkspaceList | undefined>;
}

function RunnerList(props: RunnerControllerProps): JSX.Element {
  const state = props.controller.view;
  const loading = (): JSX.Element => (
    <p class="mt-7 text-sm text-slate-400" role="status">
      Loading runners…
    </p>
  );
  const empty = (): JSX.Element => (
    <div class="mt-7 rounded-2xl border border-dashed border-white/15 p-4 text-sm leading-6 text-slate-400 sm:p-6">
      No runners yet. Set up one on every computer where you want Q Mush to run
      agents.
    </div>
  );
  return (
    <Collection
      empty={empty()}
      items={state().runners}
      listClass="mt-7 space-y-3"
      loading={loading()}
      retry={{
        error: state().error,
        onRetry: (): void => void props.controller.load(),
      }}
    >
      {(runner) => {
        const item: RunnerItemProps = {
          controller: props.controller,
          runner,
          state: state(),
          ...optionalWorkspaces(props.workspaces),
        };

        return <RunnerItem {...item} />;
      }}
    </Collection>
  );
}

export function RunnerPanel(props: RunnerControllerProps): JSX.Element {
  const state = props.controller.view;
  return (
    <section
      aria-labelledby="runners-title"
      class="min-w-0 rounded-3xl border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-6 lg:p-8"
      data-runner-panel="true"
      {...renderDebugBoundary("runners-panel", "Runners panel")}
    >
      <header class="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-emerald-300">
            Distributed runtime
          </p>
          <h2 class="mt-2 text-2xl font-semibold text-white" id="runners-title">
            Runners
          </h2>
          <p class="mt-3 max-w-2xl leading-7 text-slate-400">
            Add as many computers as you want. Install exactly one runner per
            computer; each one connects securely back to your user.
          </p>
        </div>
        <button
          class="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-2xl bg-emerald-300 px-5 py-3 text-center font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 sm:w-auto"
          disabled={state().creating}
          onClick={() => {
            void props.controller.create();
          }}
          type="button"
        >
          {state().creating ? "Preparing…" : "Set up a runner"}
        </button>
      </header>

      <RunnerSetup controller={props.controller} state={state()} />
      <RunnerList
        controller={props.controller}
        {...optionalWorkspaces(props.workspaces)}
      />
    </section>
  );
}

interface RunnerPanelController {
  readonly view: Accessor<RunnerViewState>;
  copyCommand(): Promise<void>;
  create(): Promise<void>;
  load(): Promise<void>;
  remove(runnerId: string): Promise<void>;
  setDefault(runnerId: string): Promise<void>;
  setScopes(runnerId: string, workspaceIds: readonly string[]): Promise<void>;
}
