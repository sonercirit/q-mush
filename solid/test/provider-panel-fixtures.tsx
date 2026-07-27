import type { JSX } from "solid-js";
import { OPENAI_PANEL, ProviderPanel } from "../../solid/provider-client.tsx";
import type { ProviderController } from "../../solid/provider-controller.ts";

export function openAiProviderPanel(
  controller: ProviderController,
): JSX.Element {
  return <ProviderPanel configuration={OPENAI_PANEL} controller={controller} />;
}
