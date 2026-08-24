import { type Accessor } from "solid-js";
import { runnerDirectoriesPath } from "../shared/routes.ts";
import {
  readRunnerDirectoryListing,
  type RunnerDirectoryListing,
} from "../shared/runner-directory-model.ts";
import { isHttpResponseError, requestJson } from "./browser-http.ts";
import { createReactiveState } from "./reactive-state.ts";

export interface DirectoryPickerState {
  readonly error: string | undefined;
  readonly listing: RunnerDirectoryListing | undefined;
  readonly loading: boolean;
  readonly open: boolean;
  readonly requestedPath: string | undefined;
  readonly runnerId: string | undefined;
  readonly workspaceId: string | undefined;
}

export function initialDirectoryPickerState(): DirectoryPickerState {
  return {
    error: undefined,
    listing: undefined,
    loading: false,
    open: false,
    requestedPath: undefined,
    runnerId: undefined,
    workspaceId: undefined,
  };
}

function browsingError(error: unknown): string {
  return isHttpResponseError(error) && error.status === 409
    ? "That runner is no longer available."
    : "We could not open that directory on the runner.";
}

export interface DirectoryPickerController {
  readonly state: DirectoryPickerState;
  readonly view: Accessor<DirectoryPickerState>;
  browse(path: string): Promise<void>;
  choose(): string | undefined;
  close(): void;
  open(runnerId: string, path: string, workspaceId?: string): Promise<void>;
  reset(): void;
  retry(): Promise<void>;
}

export function createDirectoryPickerController(
  view = createReactiveState(initialDirectoryPickerState()),
): DirectoryPickerController {
  let abort: AbortController | undefined;
  let request = 0;
  const controller: DirectoryPickerController = {
    get state() {
      return view.state();
    },

    get view() {
      return view.state;
    },

    browse(path: string): Promise<void> {
      const runnerId = this.state.runnerId;
      return runnerId === undefined
        ? Promise.resolve()
        : load(runnerId, path, false);
    },

    choose(): string | undefined {
      const path = this.state.listing?.path;

      if (path !== undefined) {
        controller.close();
      }

      return path;
    },

    close(): void {
      resetState();
    },

    open(runnerId: string, path: string, workspaceId?: string): Promise<void> {
      return load(runnerId, path, true, workspaceId);
    },

    reset(): void {
      resetState();
    },

    retry(): Promise<void> {
      const path = this.state.requestedPath;
      return path === undefined ? Promise.resolve() : controller.browse(path);
    },
  };

  function resetState(): void {
    cancel();
    view.setState(initialDirectoryPickerState());
  }

  function cancel(): void {
    request += 1;
    abort?.abort();
    abort = undefined;
  }

  async function load(
    runnerId: string,
    path: string,
    clearListing: boolean,
    workspaceId = controller.state.workspaceId,
  ): Promise<void> {
    cancel();
    const requestId = request;
    const abortController = new AbortController();
    abort = abortController;
    view.setState({
      error: undefined,
      listing: clearListing ? undefined : controller.state.listing,
      loading: true,
      open: true,
      requestedPath: path,
      runnerId,
      workspaceId,
    });

    try {
      const listing = readRunnerDirectoryListing(
        await requestJson(runnerDirectoriesPath(runnerId, workspaceId), {
          body: JSON.stringify({ path }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: abortController.signal,
        }),
      );

      if (requestId !== request) {
        return;
      }

      view.setState({ ...controller.state, listing, loading: false });
    } catch (error) {
      if (requestId === request) {
        view.setState({
          ...controller.state,
          error: browsingError(error),
          loading: false,
        });
      }
    } finally {
      if (requestId === request) {
        abort = undefined;
      }
    }
  }

  return controller;
}
