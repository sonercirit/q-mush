import type { Accessor } from "solid-js";
import type { ReactiveState } from "./reactive-state.ts";

export function jsonRequestInit(
  body: unknown,
  method: "PATCH" | "POST" | "PUT",
): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  };
}

interface ControllerRevision {
  readonly value: () => number;
  readonly advance: () => void;
  readonly begin: () => number;
  readonly isCurrent: (revision: number) => boolean;
}

function createControllerRevision(): ControllerRevision {
  let value = 0;
  const advance = (): void => {
    value += 1;
  };
  return {
    value: () => value,
    advance,
    begin() {
      advance();
      return value;
    },
    isCurrent: (revision) => revision === value,
  };
}

export interface ControllerMutationOptions<State> {
  readonly expected: number;
  readonly failure: (error: unknown) => Partial<State>;
  readonly init?: RequestInit;
  readonly input: RequestInfo | URL;
  readonly reload?: () => Promise<void>;
  readonly request: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<unknown>;
  readonly success: Partial<State>;
}

export class ControllerState<State extends object> {
  readonly #view: ReactiveState<State>;
  readonly revision = createControllerRevision();

  constructor(view: ReactiveState<State>) {
    this.#view = view;
  }

  get accessor(): Accessor<State> {
    return this.#view.state;
  }

  get value(): State {
    return this.#view.state();
  }

  begin(patch: Partial<State>): number {
    const revision = this.revision.begin();
    this.patch(patch);
    return revision;
  }

  async load<Value>(options: {
    readonly failure: (error: unknown) => Partial<State>;
    readonly pending: Partial<State>;
    readonly request: () => Promise<Value>;
    readonly success: (value: Value) => Partial<State>;
  }): Promise<Value | undefined> {
    const revision = this.begin(options.pending);
    try {
      const value = await options.request();
      if (this.revision.isCurrent(revision)) {
        this.patch(options.success(value));
        return value;
      }
    } catch (error) {
      if (this.revision.isCurrent(revision)) {
        this.patch(options.failure(error));
      }
    }
    return undefined;
  }

  mutate(
    options: Omit<ControllerMutationOptions<State>, "expected">,
    pending?: Partial<State>,
  ): Promise<void> {
    return this.#mutate({
      ...options,
      expected:
        pending === undefined ? this.revision.begin() : this.begin(pending),
    });
  }

  async #mutate(options: ControllerMutationOptions<State>): Promise<void> {
    try {
      await options.request(options.input, options.init);
      if (this.#patchCurrent(options.expected, options.success)) {
        await options.reload?.();
      }
    } catch (error) {
      this.#patchCurrent(options.expected, options.failure(error));
    }
  }

  #patchCurrent(expected: number, patch: Partial<State>): boolean {
    if (!this.revision.isCurrent(expected)) {
      return false;
    }
    this.patch(patch);
    return true;
  }

  mutation(
    input: RequestInfo | URL,
    init: RequestInit,
    request: ControllerMutationOptions<State>["request"],
    failure: (error: unknown) => Partial<State>,
    pending: Partial<State>,
    settled: Partial<State>,
    reload?: () => Promise<void>,
  ): Promise<void> {
    return this.mutate(
      {
        failure,
        init,
        input,
        ...(reload === undefined ? {} : { reload }),
        request,
        success: settled,
      },
      pending,
    );
  }

  patch(patch: Partial<State>): void {
    const next = { ...this.value, ...patch };
    this.#view.setState(() => next);
  }

  replace(state: State): void {
    this.#view.setState(() => state);
  }

  reset(state: State): void {
    this.revision.advance();
    this.replace(state);
  }
}
