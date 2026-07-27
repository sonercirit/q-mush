import { createMemo, Show, type JSX } from "solid-js";
import type { OpenRouterProviderCatalog } from "../shared/agent-configuration.ts";
import { RetryNotice } from "./collection.tsx";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import { formatTokenCount } from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";

export interface SessionProviderDiscoveryState {
  readonly catalog: OpenRouterProviderCatalog | undefined;
  readonly error: string | undefined;
  readonly key: string | undefined;
  readonly loading: boolean;
}

function options(
  catalog: OpenRouterProviderCatalog | undefined,
): readonly CustomSelectOption[] {
  return [
    { label: "OpenRouter automatic routing", value: "" },
    ...(catalog?.providers ?? []).map((provider) => ({
      ...(provider.contextWindow === null
        ? {}
        : { detail: `${formatTokenCount(provider.contextWindow)} context` }),
      label: provider.name,
      value: provider.tag,
    })),
  ];
}

function status(discovery: SessionProviderDiscoveryState | undefined): string {
  if (discovery?.loading === true) {
    return "Loading available serving providers… Automatic routing is available.";
  }
  if (discovery?.error !== undefined) {
    return "Serving providers unavailable. Automatic routing is available.";
  }
  return (discovery?.catalog?.providers.length ?? 0) === 0
    ? "No explicit serving providers are currently available. Automatic routing is available."
    : "Restrict this session to one current OpenRouter endpoint, or keep automatic routing.";
}

export function OpenRouterProviderSelect(props: {
  readonly controller: SessionController;
  readonly creating: boolean;
  readonly discovery: SessionProviderDiscoveryState | undefined;
  readonly open: boolean;
  readonly selectedValue: string;
}): JSX.Element {
  const selectOptions = createMemo(() => options(props.discovery?.catalog));
  return (
    <>
      <CustomSelect
        disabled={props.creating}
        emptyLabel="OpenRouter automatic routing"
        id="session-openrouter-provider"
        label="Serving provider"
        name="openRouterProviderTag"
        onChoose={(value) => {
          props.controller.chooseOption(
            "openRouterProviderTag",
            value,
            selectOptions().map((option) => option.value),
          );
        }}
        onToggle={() => {
          props.controller.toggleSelect("openRouterProviderTag");
        }}
        open={props.open}
        options={selectOptions()}
        required={false}
        selectedValue={props.selectedValue}
      />
      <p aria-live="polite" class="self-end text-xs leading-5 text-slate-500">
        {status(props.discovery)}
      </p>
      <Show when={props.discovery?.error !== undefined}>
        <RetryNotice
          error="Serving providers are unavailable. Automatic routing remains available."
          onRetry={() => {
            props.controller.retryProviders();
          }}
          retryLabel="Retry serving-provider discovery"
        />
      </Show>
    </>
  );
}
