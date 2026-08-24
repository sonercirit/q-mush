import { type Accessor } from "solid-js";
import {
  connectionScopesPath,
  runnerDefaultPath,
  RUNNERS_PATH,
} from "../shared/routes.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { isHttpResponseError, request, requestJson } from "./browser-http.ts";
import {
  createControllerState,
  jsonRequestInit,
} from "./controller-mutation.ts";
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

export interface RunnerController {
  readonly state: RunnerViewState;
  readonly view: Accessor<RunnerViewState>;
  applyRealtime(runners: readonly RunnerSummary[]): void;
  copyCommand(): Promise<void>;
  create(): Promise<void>;
  load(): Promise<void>;
  remove(runnerId: string): Promise<void>;
  reset(): void;
  setDefault(runnerId: string): Promise<void>;
  setScopes(runnerId: string, workspaceIds: readonly string[]): Promise<void>;
  setWorkspace(workspaceId: string): void;
}

export function createRunnerController(
  view = createReactiveState(initialRunnerState()),
): RunnerController {
  const stateController = createControllerState(view);
  let workspaceId = GLOBAL_WORKSPACE_ID;
  let pendingRemovalRunners: readonly RunnerSummary[] | undefined;

  function applyRealtime(runners: readonly RunnerSummary[]): void {
    const removingId = stateController.value.removingId;
    if (removingId !== undefined) {
      if (!runners.some(({ id }) => id === removingId)) {
        pendingRemovalRunners = runners;
      }
      return;
    }
    if (stateController.value.creating || stateController.value.settingDefaultId !== undefined) {
      return;
    }

    applyList(runners);
  }

  function copyCommandAction(): Promise<void> {
    return copyCommand();
  }

  function create(): Promise<void> {
    return createRunner();
  }

  function load(): Promise<void> {
    return readList(true);
  }

  function remove(runnerId: string): Promise<void> {
    return mutate("remove", runnerId);
  }

  function setWorkspace(nextWorkspaceId: string): void {
    workspaceId = nextWorkspaceId;
    pendingRemovalRunners = undefined;
    stateController.reset(initialRunnerState());
  }

  function reset(): void {
    setWorkspace(GLOBAL_WORKSPACE_ID);
  }

  function setScopes(runnerId: string, workspaceIds: readonly string[]): Promise<void> {
    return stateController.mutation(
      connectionScopesPath(RUNNERS_PATH, runnerId),
      jsonRequestInit({ workspaceIds }, "PUT"),
      request,
      () => ({ error: "We could not update that runner scope." }),
      { error: undefined },
      {},
      () => readList(false),
    );
  }

  function setDefault(runnerId: string): Promise<void> {
    return mutate("default", runnerId);
  }

  function applyList(runners: readonly RunnerSummary[]): void {
    const setup = setupAfterRefresh(stateController.value.setup, runners);

    if (
      runnerListsMatch(stateController.value.runners, runners) &&
      stateController.value.setup === setup
    ) {
      stateController.replace({ ...stateController.value, runners });
      return;
    }

    patch({ error: undefined, runners, setup });
  }

  async function copyCommand(): Promise<void> {
    const command = stateController.value.setup?.command;

    if (command === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      patch({ copied: true, error: undefined });
    } catch {
      patch({
        copied: false,
        error:
          "The command could not be copied. Select it and copy it manually.",
      });
    }
  }

  async function createRunner(): Promise<void> {
    const revision = begin({
      copied: false,
      creating: true,
      error: undefined,
    });

    try {
      const created = readCreatedRunner(
        await requestJson(
          `${RUNNERS_PATH}?workspaceId=${encodeURIComponent(workspaceId)}`,
          { method: "POST" },
        ),
      );

      if (isCurrent(revision)) {
        const current = stateController.value.runners ?? [];
        patch({
          creating: false,
          runners: [...current, created.runner],
          setup: created.setup,
        });
      }
    } catch (error) {
      if (isCurrent(revision)) {
        const unavailable = isHttpResponseError(error) && error.status === 503;
        patch({
          creating: false,
          error: unavailable
            ? "Runner setup is not available on this server."
            : "We could not prepare that runner. Please try again.",
        });
      }
    }
  }

  function begin(statePatch: Partial<RunnerViewState>): number {
    const revision = stateController.revision.begin();
    patch(statePatch);
    return revision;
  }

  function isCurrent(revision: number): boolean {
    return stateController.revision.isCurrent(revision);
  }

  async function readList(showLoading: boolean): Promise<void> {
    const revision = showLoading
      ? begin({ error: undefined, runners: undefined })
      : stateController.revision.begin();

    try {
      const runners = readRunners(
        await requestJson(
          `${RUNNERS_PATH}?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
      );

      if (isCurrent(revision)) {
        applyList(runners);
      }
    } catch {
      if (isCurrent(revision) && showLoading) {
        patch({
          error: "We could not load your runners. Please try again.",
        });
      }
    }
  }

  function mutationConfiguration(
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
            runners: defaultedRunners(stateController.value.runners, id),
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
            runners: stateController.value.runners?.filter((runner) => runner.id !== id),
            setup: setupWithoutRunner(stateController.value.setup, id),
          }),
        };
  }

  async function mutate(mutation: RunnerMutation, runnerId: string): Promise<void> {
    const configuration = mutationConfiguration(mutation, runnerId);
    if (mutation === "remove") {
      pendingRemovalRunners = undefined;
    }
    const revision = begin({
      error: undefined,
      [configuration.pending]: runnerId,
    });

    try {
      await request(configuration.input, { method: configuration.method });

      if (isCurrent(revision)) {
        patch(configuration.success(runnerId));
        if (mutation === "remove") {
          applyPendingRemovalList();
        }
      }
    } catch {
      if (isCurrent(revision)) {
        patch({
          error: configuration.failure,
          [configuration.pending]: undefined,
        });
        if (mutation === "remove") {
          applyPendingRemovalList();
        }
      }
    }
  }

  function applyPendingRemovalList(): void {
    const realtime = pendingRemovalRunners;
    pendingRemovalRunners = undefined;
    if (realtime !== undefined) {
      applyList(realtime);
    }
  }

  function patch(patch: Partial<RunnerViewState>): void {
    stateController.patch(patch);
  }
  return {
    get state() { return stateController.value; },
    get view() { return stateController.accessor; },
    applyRealtime, copyCommand: copyCommandAction, create, load, remove, reset, setDefault,
    setScopes, setWorkspace,
  };
}
