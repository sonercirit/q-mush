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

export interface ToolSettingsController {
  readonly settings: ToolSettings | undefined;
  readonly view: Accessor<ToolSettingsViewState>;
  apply(settings: ToolSettings): void;
  load(): Promise<void>;
  reset(): void;
  save(settings: ToolSettings): Promise<void>;
}

export function createToolSettingsController(
  view: ReactiveState<ToolSettingsViewState> = createReactiveState(
    initialState(),
  ),
): ToolSettingsController {
  const state = new ControllerState(view);
  return {
    get settings() {
      return state.value.settings;
    },
    get view() {
      return state.accessor;
    },
    apply(settings) {
      state.reset({
        ...state.value,
        error: undefined,
        loading: false,
        settings,
      });
    },
    load() {
      return state
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
    },
    reset() {
      state.reset(initialState());
    },
    save(settings) {
      return state.mutate(
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
    },
  };
}
