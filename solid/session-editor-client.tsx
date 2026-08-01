import {
  createSignal,
  Show,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js";

export const SESSION_EDITOR_GROUP_CLASSES =
  "mt-3 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.03]";
const SESSION_EDITOR_SECTION_CLASSES = "px-4 py-2";
const SESSION_EDITOR_DESCRIPTION_CLASSES =
  "mt-1 text-xs leading-5 text-slate-500";

function SessionEditorDescription(props: {
  readonly children: JSX.Element;
}): JSX.Element {
  return <p class={SESSION_EDITOR_DESCRIPTION_CLASSES}>{props.children}</p>;
}

interface SessionEditorSectionProps {
  readonly children: JSX.Element;
  readonly description: JSX.Element;
  readonly kind: "provider" | "spawn" | "tools";
  readonly title: string;
}

export function SessionEditorError(props: {
  readonly message: string | undefined;
}): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="mt-4 text-sm text-rose-200" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}

export function SessionEditorSection(
  props: SessionEditorSectionProps,
): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <section class={SESSION_EDITOR_SECTION_CLASSES}>
      <h4 class="flex min-w-0 items-center justify-between gap-3 text-sm font-semibold text-slate-200">
        <span>{props.title}</span>
        <button
          aria-expanded={expanded()}
          class="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          data-session-provider-toggle={
            props.kind === "provider" ? "true" : undefined
          }
          data-session-spawn-toggle={
            props.kind === "spawn" ? "true" : undefined
          }
          data-session-tool-toggle={props.kind === "tools" ? "true" : undefined}
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded() ? "Collapse" : "Expand"}
        </button>
      </h4>
      <Show when={expanded()}>
        <SessionEditorDescription>{props.description}</SessionEditorDescription>
        {props.children}
      </Show>
    </section>
  );
}

export interface SessionEditorRequestState {
  readonly error: Accessor<string | undefined>;
  readonly latest: LatestRequest;
  readonly pending: Accessor<boolean>;
  readonly setError: Setter<string | undefined>;
  readonly setPending: Setter<boolean>;
}

export function createSessionEditorRequestState(): SessionEditorRequestState {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  return {
    error,
    latest: createLatestRequest(),
    pending,
    setError,
    setPending,
  };
}

interface LatestRequest {
  begin(): number;
  isLatest(request: number): boolean;
}

function createLatestRequest(): LatestRequest {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isLatest: (request) => request === latest,
  };
}
