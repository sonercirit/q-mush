import { type JSX } from "solid-js";

type RenderHeat = "green" | "lime" | "orange" | "red" | "yellow";

interface RenderMeasurement {
  readonly count: number;
  readonly heat: RenderHeat;
}

const RENDER_BOUNDARY_SELECTOR = "[data-render-boundary]";

function renderHeat(count: number): RenderHeat {
  if (count >= 9) {
    return "red";
  }

  if (count >= 7) {
    return "orange";
  }

  if (count >= 5) {
    return "yellow";
  }

  return count >= 3 ? "lime" : "green";
}

export function renderDebugBoundary(
  key: string,
  label: string,
): Readonly<Record<string, string>> {
  return {
    "data-render-boundary": key,
    "data-render-label": label,
  };
}

export class RenderDebugView {
  readonly #counts = new Map<string, number>();
  #enabled = false;

  apply(container: Element): void {
    for (const element of container.querySelectorAll(
      RENDER_BOUNDARY_SELECTOR,
    )) {
      const key = element.getAttribute("data-render-boundary");

      if (key === null) {
        continue;
      }

      const measurement = this.record(key);

      if (this.#enabled) {
        element.setAttribute("data-render-count", String(measurement.count));
        element.setAttribute("data-render-debug", "true");
        element.setAttribute("data-render-heat", measurement.heat);
      }
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  record(key: string): RenderMeasurement {
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return { count, heat: renderHeat(count) };
  }

  reset(): void {
    this.#counts.clear();
  }

  toggle(): void {
    this.#enabled = !this.#enabled;
  }
}

export function renderDebugToggle(enabled: boolean): JSX.Element {
  return (
    <button
      aria-pressed={enabled}
      class={`rounded-full border px-3 py-1 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 ${enabled ? "border-amber-300/40 bg-amber-300/15 text-amber-100" : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200"}`}
      data-action="toggle-render-debug"
      type="button"
    >
      Render debug
    </button>
  );
}

export function renderDebugLegend(): JSX.Element {
  return (
    <aside
      aria-label="Render debug legend"
      class="fixed right-4 bottom-4 z-[100] w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-4 shadow-2xl shadow-black/60 backdrop-blur sm:right-6 sm:bottom-6"
    >
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm font-semibold text-white">Render debug</p>
        <button
          class="text-xs font-semibold text-slate-400 underline underline-offset-4 hover:text-white"
          data-action="reset-render-debug"
          type="button"
        >
          Reset
        </button>
      </div>
      <p class="mt-2 text-xs leading-5 text-slate-400">
        Borders heat up as a visible UI boundary renders again. Hover a border
        to identify it and see its count.
      </p>
      <div
        aria-hidden="true"
        class="render-debug-scale mt-3 h-2 rounded-full"
      ></div>
      <div class="mt-1.5 flex justify-between text-[0.65rem] font-medium text-slate-500">
        <span>Few renders</span>
        <span>Frequent renders</span>
      </div>
    </aside>
  );
}
