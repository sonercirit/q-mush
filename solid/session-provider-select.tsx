import { createMemo, Show, type JSX } from "solid-js";
import {
  OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE,
  OPENROUTER_PROVIDER_SORTS,
  openRouterProviderOrderValue,
  openRouterProviderSortValue,
  type OpenRouterProviderCatalog,
  type OpenRouterProviderSort,
} from "../shared/agent-configuration.ts";
import { RetryNotice } from "./collection.tsx";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import { formatTokenCount } from "./session-context-client.tsx";

export interface SessionProviderDiscoveryState {
  readonly catalog: OpenRouterProviderCatalog | undefined;
  readonly error: string | undefined;
  readonly key: string | undefined;
  readonly loading: boolean;
}

const SORT_LABELS: Readonly<Record<OpenRouterProviderSort, string>> = {
  exacto: "quality for tool use",
  latency: "latency",
  price: "price",
  throughput: "throughput",
};

function routingOptions(): readonly CustomSelectOption[] {
  return [
    { label: "OpenRouter automatic routing", value: "" },
    {
      label: "OpenRouter automatic routing without fallbacks",
      value: OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE,
    },
    ...OPENROUTER_PROVIDER_SORTS.map((sort) => ({
      label: `OpenRouter sort by ${SORT_LABELS[sort]}`,
      value: openRouterProviderSortValue(sort),
    })),
  ];
}

function providerOption(
  provider: OpenRouterProviderCatalog["providers"][number],
  fallback: boolean,
): CustomSelectOption {
  return {
    ...(provider.contextWindow === null
      ? {}
      : { detail: `${formatTokenCount(provider.contextWindow)} context` }),
    label: fallback
      ? `${provider.name} first, with automatic fallback`
      : provider.name,
    value: fallback ? openRouterProviderOrderValue(provider.tag) : provider.tag,
  };
}

function catalogProviderOptions(
  catalog: OpenRouterProviderCatalog | undefined,
  fallback: boolean,
): readonly CustomSelectOption[] {
  return (catalog?.providers ?? []).map((provider) =>
    providerOption(provider, fallback),
  );
}

function options(
  catalog: OpenRouterProviderCatalog | undefined,
): readonly CustomSelectOption[] {
  return [
    ...routingOptions(),
    ...catalogProviderOptions(catalog, false),
    ...catalogProviderOptions(catalog, true),
  ];
}

function status(discovery: SessionProviderDiscoveryState | undefined): string {
  if (discovery?.loading === true) {
    return "Loading available serving providers… Routing modes remain available.";
  }
  if (discovery?.error !== undefined) {
    return "Serving providers unavailable. Routing modes remain available.";
  }
  return (discovery?.catalog?.providers.length ?? 0) === 0
    ? "No explicit serving providers are currently available. Routing modes remain available."
    : "Choose automatic routing, a routing mode, or restrict this session to one current OpenRouter endpoint.";
}

interface OpenRouterProviderSelectController {
  chooseOption(
    name: "openRouterProviderTag",
    value: string,
    availableValues: readonly string[],
  ): void;
  retryProviders(): void;
  toggleSelect(name: "openRouterProviderTag"): void;
}

export function OpenRouterProviderSelect(props: {
  readonly controller: OpenRouterProviderSelectController;
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
          error="Serving providers are unavailable. Routing modes remain available."
          onRetry={() => {
            props.controller.retryProviders();
          }}
          retryLabel="Retry serving-provider discovery"
        />
      </Show>
    </>
  );
}
