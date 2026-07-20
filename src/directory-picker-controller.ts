import { HttpResponseError, requestJson } from "./browser-http.ts";
import { runnerDirectoriesPath } from "./routes.ts";
import {
  readRunnerDirectoryListing,
  type RunnerDirectoryListing,
} from "./runner-directory-model.ts";

export interface DirectoryPickerState {
  readonly error: string | undefined;
  readonly listing: RunnerDirectoryListing | undefined;
  readonly loading: boolean;
  readonly open: boolean;
  readonly requestedPath: string | undefined;
  readonly runnerId: string | undefined;
}

type ChangeListener = () => void;

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
  readonly #onChange: ChangeListener;
  #request = 0;
  #state = initialDirectoryPickerState();

  constructor(onChange: ChangeListener) {
    this.#onChange = onChange;
  }

  get state(): DirectoryPickerState {
    return this.#state;
  }

  browse(path: string): Promise<void> {
    const runnerId = this.#state.runnerId;
    return runnerId === undefined
      ? Promise.resolve()
      : this.#load(runnerId, path, false);
  }

  choose(): string | undefined {
    const path = this.#state.listing?.path;

    if (path !== undefined) {
      this.close();
    }

    return path;
  }

  close(): void {
    this.#cancel();
    this.#state = initialDirectoryPickerState();
    this.#onChange();
  }

  open(runnerId: string, path: string): Promise<void> {
    return this.#load(runnerId, path, true);
  }

  reset(): void {
    this.#cancel();
    this.#state = initialDirectoryPickerState();
  }

  retry(): Promise<void> {
    const path = this.#state.requestedPath;
    return path === undefined ? Promise.resolve() : this.browse(path);
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
    this.#state = {
      error: undefined,
      listing: clearListing ? undefined : this.#state.listing,
      loading: true,
      open: true,
      requestedPath: path,
      runnerId,
    };
    this.#onChange();

    try {
      const listing = readRunnerDirectoryListing(
        await requestJson(runnerDirectoriesPath(runnerId), {
          body: JSON.stringify({ path }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        }),
      );

      if (request === this.#request) {
        this.#state = { ...this.#state, listing, loading: false };
        this.#onChange();
      }
    } catch (error) {
      if (request === this.#request) {
        this.#state = {
          ...this.#state,
          error: browsingError(error),
          loading: false,
        };
        this.#onChange();
      }
    } finally {
      if (request === this.#request) {
        this.#abort = undefined;
      }
    }
  }
}
