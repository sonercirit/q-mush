import { type Accessor } from "solid-js";
import {
  connectionScopesPath,
  runnerDefaultPath,
  RUNNERS_PATH,
} from "../shared/routes.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import { ControllerState, jsonRequestInit } from "./controller-mutation.ts";
import { createReactiveState } from "./reactive-state.ts";
import {
  createRunnerViewState,
  readCreatedRunner,
  readRunners,
  type RunnerSetupInstructions,
  type RunnerViewState,
} from "./runner-client.tsx";
import {
  defaultedRunners,
  setupWithoutRunner,
} from "./runner-controller-state.ts";

type RunnerMutation = "default" | "remove";

interface RunnerMutationConfiguration {
  readonly failure: string;
  readonly input: RequestInfo;
  readonly method: "DELETE" | "POST";
  readonly pending: "removingId" | "settingDefaultId";
  readonly success: (runnerId: string) => Partial<RunnerViewState>;
}

function initialRunnerState(): RunnerViewState {
  return createRunnerViewState(undefined);
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
    left.isDefault === right.isDefault &&
    left.isGlobal === right.isGlobal &&
    left.name === right.name &&
    left.platform === right.platform &&
    left.status === right.status &&
    left.workspaceIds?.length === right.workspaceIds?.length &&
    left.workspaceIds?.every(
      (workspaceId, index) => workspaceId === right.workspaceIds?.[index],
    ) !== false &&
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
  readonly #state: ControllerState<RunnerViewState>;
  #workspaceId = GLOBAL_WORKSPACE_ID;
  #pendingRemovalRunners: readonly RunnerSummary[] | undefined;

  constructor(view = createReactiveState(initialRunnerState())) {
    this.#state = new ControllerState(view);
  }

  get state(): RunnerViewState {
    return this.#state.value;
  }

  get view(): Accessor<RunnerViewState> {
    return this.#state.accessor;
  }

  applyRealtime(runners: readonly RunnerSummary[]): void {
    const removingId = this.state.removingId;
    if (removingId !== undefined) {
      if (!runners.some(({ id }) => id === removingId)) {
        this.#pendingRemovalRunners = runners;
      }
      return;
    }
    if (this.state.creating || this.state.settingDefaultId !== undefined) {
      return;
    }

    this.#applyList(runners);
  }

  copyCommand(): Promise<void> {
    return this.#copyCommand();
  }

  create(): Promise<void> {
    return this.#createRunner();
  }

  load(): Promise<void> {
    return this.#readList(true);
  }

  remove(runnerId: string): Promise<void> {
    return this.#mutate("remove", runnerId);
  }

  setWorkspace(workspaceId: string): void {
    this.#workspaceId = workspaceId;
    this.#pendingRemovalRunners = undefined;
    this.#state.reset(initialRunnerState());
  }

  reset(): void {
    this.setWorkspace(GLOBAL_WORKSPACE_ID);
  }

  setScopes(runnerId: string, workspaceIds: readonly string[]): Promise<void> {
    return this.#state.mutation(
      connectionScopesPath(RUNNERS_PATH, runnerId),
      jsonRequestInit({ workspaceIds }, "PUT"),
      request,
      () => ({ error: "We could not update that runner scope." }),
      { error: undefined },
      {},
      () => this.#readList(false),
    );
  }

  setDefault(runnerId: string): Promise<void> {
    return this.#mutate("default", runnerId);
  }

  #applyList(runners: readonly RunnerSummary[]): void {
    const setup = setupAfterRefresh(this.state.setup, runners);

    if (
      runnerListsMatch(this.state.runners, runners) &&
      this.state.setup === setup
    ) {
      this.#state.replace({ ...this.state, runners });
      return;
    }

    this.#patch({ error: undefined, runners, setup });
  }

  async #copyCommand(): Promise<void> {
    const command = this.state.setup?.command;

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

  async #createRunner(): Promise<void> {
    const revision = this.#begin({
      copied: false,
      creating: true,
      error: undefined,
    });

    try {
      const created = readCreatedRunner(
        await requestJson(
          `${RUNNERS_PATH}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
          { method: "POST" },
        ),
      );

      if (this.#isCurrent(revision)) {
        const current = this.state.runners ?? [];
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
    const revision = this.#state.revision.begin();
    this.#patch(patch);
    return revision;
  }

  #isCurrent(revision: number): boolean {
    return this.#state.revision.isCurrent(revision);
  }

  async #readList(showLoading: boolean): Promise<void> {
    const revision = showLoading
      ? this.#begin({ error: undefined, runners: undefined })
      : this.#state.revision.begin();

    try {
      const runners = readRunners(
        await requestJson(
          `${RUNNERS_PATH}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
        ),
      );

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

  #mutationConfiguration(
    mutation: RunnerMutation,
    runnerId: string,
  ): RunnerMutationConfiguration {
    return mutation === "default"
      ? {
          failure: "We could not make that runner the default.",
          input: runnerDefaultPath(runnerId),
          method: "POST",
          pending: "settingDefaultId",
          success: (id) => ({
            runners: defaultedRunners(this.state.runners, id),
            settingDefaultId: undefined,
          }),
        }
      : {
          failure: "We could not remove that runner.",
          input: `${RUNNERS_PATH}/${encodeURIComponent(runnerId)}`,
          method: "DELETE",
          pending: "removingId",
          success: (id) => ({
            removingId: undefined,
            runners: this.state.runners?.filter((runner) => runner.id !== id),
            setup: setupWithoutRunner(this.state.setup, id),
          }),
        };
  }

  async #mutate(mutation: RunnerMutation, runnerId: string): Promise<void> {
    const configuration = this.#mutationConfiguration(mutation, runnerId);
    if (mutation === "remove") {
      this.#pendingRemovalRunners = undefined;
    }
    const revision = this.#begin({
      error: undefined,
      [configuration.pending]: runnerId,
    });

    try {
      await request(configuration.input, { method: configuration.method });

      if (this.#isCurrent(revision)) {
        this.#patch(configuration.success(runnerId));
        if (mutation === "remove") {
          this.#applyPendingRemovalList();
        }
      }
    } catch {
      if (this.#isCurrent(revision)) {
        this.#patch({
          error: configuration.failure,
          [configuration.pending]: undefined,
        });
        if (mutation === "remove") {
          this.#applyPendingRemovalList();
        }
      }
    }
  }

  #applyPendingRemovalList(): void {
    const realtime = this.#pendingRemovalRunners;
    this.#pendingRemovalRunners = undefined;
    if (realtime !== undefined) {
      this.#applyList(realtime);
    }
  }

  #patch(patch: Partial<RunnerViewState>): void {
    this.#state.patch(patch);
  }
}
