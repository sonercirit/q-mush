import type { Accessor } from "solid-js";

interface ViewController<State> {
  readonly view: Accessor<State>;
}

export function controllerView<State>(props: {
  readonly controller: ViewController<State>;
}): Accessor<State> {
  return () => props.controller.view();
}
