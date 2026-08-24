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

export interface ControllerState<State extends object> {
  readonly accessor: Accessor<State>;
  readonly value: State;
  readonly revision: ControllerRevision;
  begin(patch: Partial<State>): number;
  load<Value>(options: {
    readonly failure: (error: unknown) => Partial<State>;
    readonly pending: Partial<State>;
    readonly request: () => Promise<Value>;
    readonly success: (value: Value) => Partial<State>;
  }): Promise<Value | undefined>;
  mutate(
    options: Omit<ControllerMutationOptions<State>, "expected">,
    pending?: Partial<State>,
  ): Promise<void>;
  mutation(
    input: RequestInfo | URL,
    init: RequestInit,
    request: ControllerMutationOptions<State>["request"],
    failure: (error: unknown) => Partial<State>,
    pending: Partial<State>,
    settled: Partial<State>,
    reload?: () => Promise<void>,
  ): Promise<void>;
  patch(patch: Partial<State>): void;
  replace(state: State): void;
  reset(state: State): void;
}

export function createControllerState<State extends object>(
  view: ReactiveState<State>,
): ControllerState<State> {
  const revision = createControllerRevision();
  const controller: ControllerState<State> = {
    revision,
    get accessor() {
      return view.state;
    },
    get value() {
      return view.state();
    },
    begin(patch) {
      const current = revision.begin();
      controller.patch(patch);
      return current;
    },
    async load(options) {
      const current = controller.begin(options.pending);
      try {
        const value = await options.request();
        if (revision.isCurrent(current)) {
          controller.patch(options.success(value));
          return value;
        }
      } catch (error) {
        if (revision.isCurrent(current))
          controller.patch(options.failure(error));
      }
      return undefined;
    },
    mutate(options, pending) {
      const expected =
        pending === undefined ? revision.begin() : controller.begin(pending);
      return mutate({ ...options, expected });
    },
    mutation(input, init, request, failure, pending, settled, reload) {
      return controller.mutate(
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
    },
    patch(patch) {
      view.setState(() => ({ ...controller.value, ...patch }));
    },
    replace(state) {
      view.setState(() => state);
    },
    reset(state) {
      revision.advance();
      controller.replace(state);
    },
  };
  function patchCurrent(expected: number, patch: Partial<State>): boolean {
    if (!revision.isCurrent(expected)) return false;
    controller.patch(patch);
    return true;
  }
  async function mutate(
    options: ControllerMutationOptions<State>,
  ): Promise<void> {
    try {
      await options.request(options.input, options.init);
      if (patchCurrent(options.expected, options.success))
        await options.reload?.();
    } catch (error) {
      patchCurrent(options.expected, options.failure(error));
    }
  }
  return controller;
}
