import {
  createContext,
  createSignal,
  Show,
  useContext,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js";

type RenderHeat = "green" | "lime" | "orange" | "red" | "yellow";

interface RenderMeasurement {
  readonly count: number;
  readonly heat: RenderHeat;
}

interface RenderDebugBoundaryAttributes {
  readonly "data-render-boundary": string;
  readonly "data-render-count": string | undefined;
  readonly "data-render-debug": "true" | undefined;
  readonly "data-render-heat": RenderHeat | undefined;
  readonly "data-render-label": string;
}

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

export class RenderDebugView {
  readonly #counts = new Map<string, number>();
  readonly #enabled: Accessor<boolean>;
  readonly #revision: Accessor<number>;
  readonly #setEnabled: Setter<boolean>;
  readonly #setRevision: Setter<number>;

  constructor() {
    const [enabled, setEnabled] = createSignal(false);
    const [revision, setRevision] = createSignal(0);
    this.#enabled = enabled;
    this.#revision = revision;
    this.#setEnabled = setEnabled;
    this.#setRevision = setRevision;
  }

  get enabled(): boolean {
    return this.#enabled();
  }

  get enabledView(): Accessor<boolean> {
    return this.#enabled;
  }

  get revisionView(): Accessor<number> {
    return this.#revision;
  }

  measurement(key: string): RenderMeasurement {
    const count = this.#counts.get(key) ?? 0;
    return { count, heat: renderHeat(count) };
  }

  record(key: string): RenderMeasurement {
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return { count, heat: renderHeat(count) };
  }

  reset(): void {
    this.#counts.clear();
    this.#setRevision((revision) => revision + 1);
  }

  toggle(): void {
    this.#setEnabled((enabled) => !enabled);
  }
}

const RenderDebugContext = createContext<RenderDebugView>();

export function RenderDebugProvider(props: {
  readonly children: JSX.Element;
  readonly view: RenderDebugView;
}): JSX.Element {
  return (
    <RenderDebugContext.Provider value={props.view}>
      {props.children}
    </RenderDebugContext.Provider>
  );
}

export function renderDebugBoundary(
  key: string,
  label: string,
): RenderDebugBoundaryAttributes {
  const view = useContext(RenderDebugContext);
  const measurement = view?.record(key);
  const currentMeasurement = (): RenderMeasurement | undefined => {
    view?.revisionView();
    return view?.measurement(key) ?? measurement;
  };

  return {
    "data-render-boundary": key,
    get "data-render-count"(): string | undefined {
      return view?.enabled === true
        ? String(currentMeasurement()?.count ?? 0)
        : undefined;
    },
    get "data-render-debug"(): "true" | undefined {
      return view?.enabled === true ? "true" : undefined;
    },
    get "data-render-heat"(): RenderHeat | undefined {
      return view?.enabled === true ? currentMeasurement()?.heat : undefined;
    },
    "data-render-label": label,
  };
}

export function RenderDebugToggle(props: {
  readonly view: RenderDebugView;
}): JSX.Element {
  return (
    <button
      aria-pressed={props.view.enabledView()}
      class={`rounded-full border px-3 py-1 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 ${props.view.enabledView() ? "border-amber-300/40 bg-amber-300/15 text-amber-100" : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200"}`}
      onClick={() => {
        props.view.toggle();
      }}
      type="button"
    >
      Render debug
    </button>
  );
}

export function RenderDebugLegend(props: {
  readonly view: RenderDebugView;
}): JSX.Element {
  return (
    <Show when={props.view.enabledView()}>
      <aside
        aria-label="Render debug legend"
        class="fixed right-2 bottom-2 z-[100] w-[calc(100vw-1rem)] max-w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-4 shadow-2xl shadow-black/60 backdrop-blur sm:right-6 sm:bottom-6"
      >
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm font-semibold text-white">Render debug</p>
          <button
            class="text-xs font-semibold text-slate-400 underline underline-offset-4 hover:text-white"
            onClick={() => {
              props.view.reset();
            }}
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
        />
        <div class="mt-1.5 flex justify-between text-[0.65rem] font-medium text-slate-500">
          <span>Few renders</span>
          <span>Frequent renders</span>
        </div>
      </aside>
    </Show>
  );
}
