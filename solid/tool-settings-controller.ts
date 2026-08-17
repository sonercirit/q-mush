import { type Accessor } from "solid-js";
import { TOOL_SETTINGS_PATH } from "../shared/routes.ts";
import { readToolSettings, type ToolSettings } from "../shared/tool-limits.ts";
import { requestJson } from "./browser-http.ts";
import { ControllerState, jsonRequestInit } from "./controller-mutation.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";

export interface ToolSettingsViewState {
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly settings: ToolSettings | undefined;
}

function initialState(): ToolSettingsViewState {
  return {
    error: undefined,
    loading: true,
    saving: false,
    settings: undefined,
  };
}

function parseSettings(value: unknown): ToolSettings {
  const settings = readToolSettings(value);
  if (settings === undefined) {
    throw new Error("The server returned invalid tool settings");
  }
  return settings;
}

export class ToolSettingsController {
  readonly #state: ControllerState<ToolSettingsViewState>;

  constructor(
    view: ReactiveState<ToolSettingsViewState> = createReactiveState(
      initialState(),
    ),
  ) {
    this.#state = new ControllerState(view);
  }

  get settings(): ToolSettings | undefined {
    return this.#state.value.settings;
  }

  get view(): Accessor<ToolSettingsViewState> {
    return this.#state.accessor;
  }

  apply(settings: ToolSettings): void {
    this.#state.reset({
      ...this.#state.value,
      error: undefined,
      loading: false,
      settings,
    });
  }

  load(): Promise<void> {
    return this.#state
      .load({
        failure: () => ({
          error: "We could not load your tool limits.",
          loading: false,
          settings: undefined,
        }),
        pending: { error: undefined, loading: true },
        request: () => requestJson(TOOL_SETTINGS_PATH),
        success: (value) => ({
          error: undefined,
          loading: false,
          settings: parseSettings(value),
        }),
      })
      .then(() => undefined);
  }

  reset(): void {
    this.#state.reset(initialState());
  }

  save(settings: ToolSettings): Promise<void> {
    return this.#state.mutate(
      {
        failure: () => ({
          error: "We could not save your tool limits.",
          saving: false,
        }),
        init: jsonRequestInit(settings, "PUT"),
        input: TOOL_SETTINGS_PATH,
        request: requestJson,
        success: { error: undefined, saving: false, settings },
      },
      { error: undefined, saving: true },
    );
  }
}
