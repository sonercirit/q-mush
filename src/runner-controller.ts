import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import { bindActionClicks } from "./client-actions.ts";
import { RUNNERS_PATH } from "./routes.ts";
import {
  readCreatedRunner,
  readRunners,
  type RunnerSetupInstructions,
  type RunnerViewState,
} from "./runner-client.tsx";
import type { RunnerSummary } from "./runner-model.ts";

type RunnerChangeListener = () => void;

function initialRunnerState(): RunnerViewState {
  return {
    copied: false,
    creating: false,
    error: undefined,
    removingId: undefined,
    runners: undefined,
    setup: undefined,
  };
}

function setupAfterRefresh(
  setup: RunnerSetupInstructions | undefined,
  runners: readonly RunnerSummary[],
): RunnerSetupInstructions | undefined {
  if (setup === undefined) {
    return undefined;
  }

  const setupRunner = runners.find(({ id }) => id === setup.runnerId);
  return setupRunner?.status === "pending" ? setup : undefined;
}

function runnerPresentationMatches(
  left: RunnerSummary,
  right: RunnerSummary,
): boolean {
  return (
    left.architecture === right.architecture &&
    left.id === right.id &&
    left.name === right.name &&
    left.platform === right.platform &&
    left.status === right.status &&
    (left.status === "online" || left.lastSeenAt === right.lastSeenAt)
  );
}

function runnerListsMatch(
  left: readonly RunnerSummary[] | undefined,
  right: readonly RunnerSummary[],
): boolean {
  return (
    left?.length === right.length &&
    left.every((runner, index) => {
      const refreshedRunner = right[index];
      return (
        refreshedRunner !== undefined &&
        runnerPresentationMatches(runner, refreshedRunner)
      );
    })
  );
}

export class RunnerController {
  readonly #onChange: RunnerChangeListener;
  #revision = 0;
  #state: RunnerViewState = initialRunnerState();

  constructor(onChange: RunnerChangeListener) {
    this.#onChange = onChange;
  }

  applyRealtime(runners: readonly RunnerSummary[]): void {
    if (this.#state.creating || this.#state.removingId !== undefined) {
      return;
    }

    this.#applyList(runners);
  }

  #applyList(runners: readonly RunnerSummary[]): void {
    const setup = setupAfterRefresh(this.#state.setup, runners);

    if (
      runnerListsMatch(this.#state.runners, runners) &&
      this.#state.setup === setup
    ) {
      this.#state = { ...this.#state, runners };
      return;
    }

    this.#patch({ error: undefined, runners, setup });
  }

  bind(container: Element): void {
    const panel = container.querySelector('[data-runner-panel="true"]');

    bindActionClicks(panel, (control, action) => {
      if (action === "create-runner") {
        void this.#create();
      } else if (action === "copy-runner-command") {
        void this.#copyCommand();
      } else if (action === "retry-runners") {
        void this.load();
      } else if (action === "remove-runner") {
        const runnerId = control.dataset["runnerId"];

        if (runnerId !== undefined) {
          void this.#remove(runnerId);
        }
      }
    });
  }

  get state(): RunnerViewState {
    return this.#state;
  }

  load(): Promise<void> {
    return this.#readList(true);
  }

  reset(): void {
    this.#revision += 1;
    this.#state = initialRunnerState();
    this.#onChange();
  }

  async #copyCommand(): Promise<void> {
    const command = this.#state.setup?.command;

    if (command === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      this.#patch({ copied: true, error: undefined });
    } catch {
      this.#patch({
        copied: false,
        error:
          "The command could not be copied. Select it and copy it manually.",
      });
    }
  }

  async #create(): Promise<void> {
    const revision = this.#begin({
      copied: false,
      creating: true,
      error: undefined,
    });

    try {
      const created = readCreatedRunner(
        await requestJson(RUNNERS_PATH, { method: "POST" }),
      );

      if (this.#isCurrent(revision)) {
        const current = this.#state.runners ?? [];
        this.#patch({
          creating: false,
          runners: [...current, created.runner],
          setup: created.setup,
        });
      }
    } catch (error) {
      if (this.#isCurrent(revision)) {
        const unavailable =
          error instanceof HttpResponseError && error.status === 503;
        this.#patch({
          creating: false,
          error: unavailable
            ? "Runner setup is not available on this server."
            : "We could not prepare that runner. Please try again.",
        });
      }
    }
  }

  #begin(patch: Partial<RunnerViewState>): number {
    const revision = ++this.#revision;
    this.#patch(patch);
    return revision;
  }

  #isCurrent(revision: number): boolean {
    return revision === this.#revision;
  }

  async #readList(showLoading: boolean): Promise<void> {
    const revision = showLoading
      ? this.#begin({ error: undefined, runners: undefined })
      : ++this.#revision;

    try {
      const runners = readRunners(await requestJson(RUNNERS_PATH));

      if (this.#isCurrent(revision)) {
        this.#applyList(runners);
      }
    } catch {
      if (this.#isCurrent(revision) && showLoading) {
        this.#patch({
          error: "We could not load your runners. Please try again.",
        });
      }
    }
  }

  async #remove(runnerId: string): Promise<void> {
    const revision = this.#begin({ error: undefined, removingId: runnerId });

    try {
      await request(`${RUNNERS_PATH}/${encodeURIComponent(runnerId)}`, {
        method: "DELETE",
      });

      if (this.#isCurrent(revision)) {
        this.#patch({
          removingId: undefined,
          runners: this.#state.runners?.filter(({ id }) => id !== runnerId),
          setup:
            this.#state.setup?.runnerId === runnerId
              ? undefined
              : this.#state.setup,
        });
      }
    } catch {
      if (this.#isCurrent(revision)) {
        this.#patch({
          error: "We could not remove that runner.",
          removingId: undefined,
        });
      }
    }
  }

  #patch(patch: Partial<RunnerViewState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#onChange();
  }
}
