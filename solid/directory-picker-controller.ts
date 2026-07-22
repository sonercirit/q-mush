import { type Accessor } from "solid-js";
import { runnerDirectoriesPath } from "../shared/routes.ts";
import {
  readRunnerDirectoryListing,
  type RunnerDirectoryListing,
} from "../shared/runner-directory-model.ts";
import { HttpResponseError, requestJson } from "./browser-http.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";

export interface DirectoryPickerState {
  readonly error: string | undefined;
  readonly listing: RunnerDirectoryListing | undefined;
  readonly loading: boolean;
  readonly open: boolean;
  readonly requestedPath: string | undefined;
  readonly runnerId: string | undefined;
}

export function initialDirectoryPickerState(): DirectoryPickerState {
  return {
    error: undefined,
    listing: undefined,
    loading: false,
    open: false,
    requestedPath: undefined,
    runnerId: undefined,
  };
}

function browsingError(error: unknown): string {
  return error instanceof HttpResponseError && error.status === 409
    ? "That runner is no longer available."
    : "We could not open that directory on the runner.";
}

export class DirectoryPickerController {
  #abort: AbortController | undefined;
  #request = 0;
  readonly #view: ReactiveState<DirectoryPickerState>;

  constructor(view = createReactiveState(initialDirectoryPickerState())) {
    this.#view = view;
  }

  get state(): DirectoryPickerState {
    return this.#view.state();
  }

  get view(): Accessor<DirectoryPickerState> {
    return this.#view.state;
  }

  browse(path: string): Promise<void> {
    const runnerId = this.state.runnerId;
    return runnerId === undefined
      ? Promise.resolve()
      : this.#load(runnerId, path, false);
  }

  choose(): string | undefined {
    const path = this.state.listing?.path;

    if (path !== undefined) {
      this.close();
    }

    return path;
  }

  close(): void {
    this.#reset();
  }

  open(runnerId: string, path: string): Promise<void> {
    return this.#load(runnerId, path, true);
  }

  reset(): void {
    this.#reset();
  }

  retry(): Promise<void> {
    const path = this.state.requestedPath;
    return path === undefined ? Promise.resolve() : this.browse(path);
  }

  #reset(): void {
    this.#cancel();
    this.#view.setState(initialDirectoryPickerState());
  }

  #cancel(): void {
    this.#request += 1;
    this.#abort?.abort();
    this.#abort = undefined;
  }

  async #load(
    runnerId: string,
    path: string,
    clearListing: boolean,
  ): Promise<void> {
    this.#cancel();
    const request = this.#request;
    const controller = new AbortController();
    this.#abort = controller;
    this.#view.setState({
      error: undefined,
      listing: clearListing ? undefined : this.state.listing,
      loading: true,
      open: true,
      requestedPath: path,
      runnerId,
    });

    try {
      const listing = readRunnerDirectoryListing(
        await requestJson(runnerDirectoriesPath(runnerId), {
          body: JSON.stringify({ path }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        }),
      );

      if (request !== this.#request) {
        return;
      }

      this.#view.setState({ ...this.state, listing, loading: false });
    } catch (error) {
      if (request === this.#request) {
        this.#view.setState({
          ...this.state,
          error: browsingError(error),
          loading: false,
        });
      }
    } finally {
      if (request === this.#request) {
        this.#abort = undefined;
      }
    }
  }
}
