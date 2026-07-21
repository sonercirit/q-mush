import type { AgentModelOption } from "./agent-configuration.ts";
import { createElement, type JsxNode } from "./jsx.ts";

const Q_MUSH_SUPPORTED_MODALITIES = ["text"] as const;

function modalityLabel(modality: string): string {
  return modality.length === 0
    ? modality
    : `${modality.charAt(0).toUpperCase()}${modality.slice(1)}`;
}

function modalityListLabel(modalities: readonly string[] | null): string {
  return modalities === null
    ? "Not reported"
    : modalities.map(modalityLabel).join(", ") || "None";
}

export function modelModalitiesLabel(model: AgentModelOption): string {
  return `Input: ${modalityListLabel(model.inputModalities)} · Output: ${modalityListLabel(model.outputModalities)}`;
}

function qMushSupports(modality: string): boolean {
  return Q_MUSH_SUPPORTED_MODALITIES.some(
    (supportedModality) => supportedModality === modality,
  );
}

function renderModalityGroup(
  direction: "input" | "output",
  modalities: readonly string[] | null,
): JsxNode {
  return (
    <div data-model-modalities-direction={direction}>
      <p className="text-xs font-medium text-slate-400">
        {`${modalityLabel(direction)} modalities`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {modalities === null ? (
          <span className="text-xs text-slate-500">Not reported</span>
        ) : modalities.length === 0 ? (
          <span className="text-xs text-slate-500">None</span>
        ) : (
          modalities.map((modality) => {
            const supported = qMushSupports(modality);
            return (
              <span
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${supported ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : "border-slate-400/20 bg-slate-400/10 text-slate-400"}`}
              >
                {`${modalityLabel(modality)} · ${supported ? "Supported by Q Mush" : "Not yet supported by Q Mush"}`}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

export function renderModelModalities(
  model: AgentModelOption | undefined,
): JsxNode {
  if (model === undefined) {
    return null;
  }

  return (
    <div
      className="grid gap-3 lg:col-span-2 sm:grid-cols-2"
      data-model-modalities="true"
    >
      {renderModalityGroup("input", model.inputModalities)}
      {renderModalityGroup("output", model.outputModalities)}
    </div>
  );
}
