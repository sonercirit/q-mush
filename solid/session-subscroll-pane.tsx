import { createSignal, onCleanup, onMount, type JSX } from "solid-js";

export interface SubscrollPaneOptions {
  readonly label: string;
  readonly pane: (wrapped: () => boolean) => JSX.Element;
}

export function SubscrollPane(props: SubscrollPaneOptions): JSX.Element {
  const [wrapped, setWrapped] = createSignal(true);
  const [pane, setPane] = createSignal<HTMLDivElement>();
  let restore: ((event: Event) => void) | undefined;
  onMount(() => {
    restore = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail === "boolean") {
        setWrapped(event.detail);
      }
    };
    pane()?.addEventListener("subscroll-wrap-restore", restore);
  });
  onCleanup(() => {
    if (restore !== undefined) {
      pane()?.removeEventListener("subscroll-wrap-restore", restore);
    }
  });
  const toggle = (): void => {
    const next = !wrapped();
    setWrapped(next);
    pane()?.dispatchEvent(
      new CustomEvent("subscroll-wrap-change", {
        bubbles: true,
        detail: next,
      }),
    );
  };
  return (
    <div class="relative min-w-0" ref={setPane}>
      <button
        aria-label={`Line wrap for ${props.label}`}
        aria-pressed={wrapped()}
        class={`absolute top-2 right-2 z-10 rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 ${wrapped() ? "border-emerald-300/30 bg-slate-950/90 text-emerald-200" : "border-white/15 bg-slate-950/90 text-slate-400 hover:border-white/30 hover:text-slate-200"}`}
        data-subscroll-wrap-toggle="true"
        onClick={toggle}
        type="button"
      >
        {`Wrap: ${wrapped() ? "On" : "Off"}`}
      </button>
      {props.pane(wrapped)}
    </div>
  );
}

export function subscrollPaneClasses(classes: string): string {
  return `${classes} data-[line-wrap=true]:overflow-x-hidden data-[line-wrap=true]:whitespace-pre-wrap data-[line-wrap=true]:[overflow-wrap:anywhere] data-[line-wrap=false]:overflow-x-auto data-[line-wrap=false]:whitespace-pre`;
}
