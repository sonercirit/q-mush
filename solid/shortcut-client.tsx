import {
  createContext,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
  type JSX,
} from "solid-js";
import {
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
  shortcutAriaKey,
  shortcutDefinition,
  shortcutDisplayLabel,
  type ApplicationShortcutAction,
} from "./shortcut-registry.ts";

const ShortcutRegistryContext = createContext<KeyboardShortcutRegistry>();
const fallbackShortcutRegistry = new KeyboardShortcutRegistry({
  eventTarget: undefined,
  platform: "other",
});

function useShortcutRegistry(): KeyboardShortcutRegistry {
  return useContext(ShortcutRegistryContext) ?? fallbackShortcutRegistry;
}

export function shortcutKeys(action: ApplicationShortcutAction): string {
  const registry = useShortcutRegistry();
  return shortcutDefinition(action)
    .keys.map((key) => shortcutAriaKey(key, registry.platform))
    .join(" ");
}

export function ShortcutHint(props: {
  readonly action: ApplicationShortcutAction;
}): JSX.Element {
  const registry = useShortcutRegistry();
  const definition = shortcutDefinition(props.action);

  return (
    <kbd
      aria-hidden="true"
      class="ml-2 hidden rounded border border-slate-950/20 bg-slate-950/10 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold leading-none sm:inline-flex"
    >
      {shortcutDisplayLabel(definition.keys[0], registry.platform)}
    </kbd>
  );
}

export function registerShortcut(
  action: ApplicationShortcutAction,
  available: () => boolean,
  handler: () => void,
  target?: () => EventTarget | undefined,
): void {
  const registry = useShortcutRegistry();
  const unregister = registry.register({
    action,
    available,
    handler,
    ...(target === undefined ? {} : { target }),
  });
  onCleanup(unregister);
}

function createShortcutHelp(
  registry: KeyboardShortcutRegistry,
  revision: () => number,
): {
  readonly close: () => void;
  readonly open: () => void;
  readonly view: JSX.Element;
} {
  const [helpOpen, setHelpOpen] = createSignal(false);
  let closeButton: HTMLButtonElement | undefined;
  let returnFocus: HTMLElement | null = null;
  const close = (): void => {
    setHelpOpen(false);
    returnFocus?.focus();
    returnFocus = null;
  };
  const open = (): void => {
    returnFocus =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setHelpOpen(true);
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        closeButton?.focus();
      });
    }
  };

  const toggle = (): void => {
    if (helpOpen()) {
      close();
    } else {
      open();
    }
  };

  return {
    close,
    open: toggle,
    view: (
      <Show when={helpOpen()}>
        <ShortcutHelp
          closeButton={(element) => {
            closeButton = element;
          }}
          onClose={close}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          registry={registry}
          revision={revision()}
        />
      </Show>
    ),
  };
}

function ShortcutHelp(props: {
  readonly closeButton?: (element: HTMLButtonElement) => void;
  readonly onClose: () => void;
  readonly onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>;
  readonly registry: KeyboardShortcutRegistry;
  readonly revision?: number;
}): JSX.Element {
  const shortcuts = (): ReturnType<KeyboardShortcutRegistry["available"]> => {
    void props.revision;
    return props.registry.available();
  };

  return (
    <div
      aria-labelledby="keyboard-shortcuts-title"
      aria-modal="true"
      class="fixed inset-0 z-[100] grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
      data-shortcut-help="true"
      onKeyDown={props.onKeyDown}
      role="dialog"
    >
      <div class="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/60">
        <div class="flex items-start justify-between gap-4 border-b border-white/10 p-5 sm:p-6">
          <div>
            <p class="text-xs font-semibold tracking-wider text-emerald-300 uppercase">
              Active view
            </p>
            <h2
              class="mt-2 text-xl font-semibold text-white"
              id="keyboard-shortcuts-title"
            >
              Keyboard shortcuts
            </h2>
          </div>
          <button
            aria-label="Close keyboard shortcuts"
            aria-keyshortcuts="Escape"
            class="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-white"
            onClick={props.onClose}
            ref={props.closeButton}
            type="button"
          >
            ×
          </button>
        </div>
        <div class="min-h-0 overflow-y-auto p-5 sm:p-6">
          <ul class="space-y-2">
            <For each={shortcuts()}>
              {(shortcut) => (
                <li class="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-slate-950/70 p-3">
                  <span class="min-w-0">
                    <span class="block text-sm font-medium text-slate-100">
                      {shortcut.label}
                    </span>
                    <span class="mt-1 block text-xs text-slate-500">
                      {shortcut.context}
                    </span>
                  </span>
                  <span class="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <For each={shortcut.displayKeys}>
                      {(keys) => (
                        <kbd class="rounded-lg border border-white/15 bg-white/[0.07] px-2 py-1 font-mono text-xs font-semibold text-cyan-100">
                          {keys}
                        </kbd>
                      )}
                    </For>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <p class="mt-4 text-xs leading-5 text-slate-500">
            Shortcuts are disabled while their actions are unavailable. Plain
            Enter keeps adding lines in prompt fields.
          </p>
        </div>
      </div>
    </div>
  );
}

function ShortcutTestPanel(props: {
  readonly registry: KeyboardShortcutRegistry;
}): JSX.Element {
  return <ShortcutHelp onClose={() => undefined} registry={props.registry} />;
}

function shortcutClientTestApi() {
  return { ShortcutTestPanel };
}

/** @internal Test access for shortcut UI that stays encapsulated in production. */
export const shortcutClientApi = { shortcutClientTestApi };

export function ShortcutProvider(props: {
  readonly children: JSX.Element;
  readonly registry?: KeyboardShortcutRegistry;
}): JSX.Element {
  const [revision, setRevision] = createSignal(0);
  const registry =
    props.registry ??
    new KeyboardShortcutRegistry({
      onChange: () => {
        setRevision((current) => current + 1);
      },
    });
  const help = createShortcutHelp(registry, revision);
  registry.register({
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    available: () => true,
    handler: help.open,
  });
  onCleanup(() => {
    registry.dispose();
  });

  return (
    <ShortcutRegistryContext.Provider value={registry}>
      {props.children}
      {help.view}
    </ShortcutRegistryContext.Provider>
  );
}
