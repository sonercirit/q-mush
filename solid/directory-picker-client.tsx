import {
  createEffect,
  createSignal,
  For,
  on,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { MAXIMUM_RUNNER_DIRECTORY_ENTRIES } from "../shared/runner-directory-model.ts";
import type { DirectoryPickerController } from "./directory-picker-controller.ts";
import { renderDebugBoundary } from "./render-debug.tsx";

export function DirectoryPicker(props: {
  readonly controller: DirectoryPickerController;
  readonly onChoose: () => void;
  readonly runnerName: string;
}): JSX.Element {
  const state = props.controller.view;
  const browse = (path: string): void => {
    void props.controller.browse(path);
  };
  const close = (): void => {
    props.controller.close();
  };
  const [dialog, setDialog] = createSignal<HTMLDivElement>();
  let focusReturnTarget: HTMLElement | undefined;

  onMount(() => {
    createEffect(
      on(
        () => state().open,
        (open, wasOpen) => {
          if (open) {
            focusReturnTarget =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : undefined;
            dialog()?.focus();
          } else if (wasOpen) {
            const returnTarget = focusReturnTarget;
            focusReturnTarget = undefined;
            queueMicrotask(() => {
              if (returnTarget?.isConnected === true) {
                returnTarget.focus({ preventScroll: true });
              }
            });
          }
        },
      ),
    );
  });

  return (
    <Show when={state().open} keyed>
      <div
        aria-labelledby="directory-picker-title"
        aria-modal="true"
        class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/80 p-2 backdrop-blur-sm sm:p-4"
        data-directory-picker="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.controller.close();
          }
        }}
        ref={setDialog}
        role="dialog"
        tabindex="-1"
      >
        <div
          class="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/60 sm:max-h-[calc(100dvh-2rem)] sm:rounded-3xl"
          {...renderDebugBoundary("directory-picker", "Directory picker")}
        >
          <div class="flex min-w-0 items-start justify-between gap-3 border-b border-white/10 p-4 sm:gap-4 sm:p-6">
            <div class="min-w-0">
              <p class="text-xs font-semibold tracking-wider text-emerald-300 uppercase">
                {props.runnerName}
              </p>
              <h3
                class="mt-2 text-xl font-semibold text-white"
                id="directory-picker-title"
              >
                Choose a working directory
              </h3>
            </div>
            <button
              aria-label="Close directory picker"
              class="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-white"
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>

          <div class="flex min-h-0 min-w-0 flex-1 flex-col p-4 sm:p-6">
            <div class="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-start">
              <button
                class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={state().loading}
                onClick={() => {
                  browse("~");
                }}
                type="button"
              >
                Home
              </button>
              <button
                class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={
                  state().loading || typeof state().listing?.parent !== "string"
                }
                onClick={() => {
                  const parent = state().listing?.parent;
                  if (typeof parent === "string") {
                    void props.controller.browse(parent);
                  }
                }}
                type="button"
              >
                Up
              </button>
              <code
                class="path-wrap col-span-2 min-w-0 rounded-lg bg-slate-950 px-3 py-2 text-xs leading-5 text-cyan-200 sm:flex-1"
                data-current-directory="true"
                title={state().listing?.path ?? state().requestedPath ?? ""}
              >
                {state().listing?.path ??
                  state().requestedPath ??
                  "Select a location"}
              </code>
            </div>

            <Show when={state().error}>
              {(error) => (
                <div
                  class="mt-4 flex items-center justify-between gap-4 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100"
                  role="alert"
                >
                  <span>{error()}</span>
                  <button
                    class="shrink-0 font-semibold underline underline-offset-4"
                    onClick={() => {
                      void props.controller.retry();
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              )}
            </Show>

            <div class="relative mt-4 min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
              <Show
                fallback={
                  <p
                    class={`grid min-h-48 place-items-center px-5 text-center text-sm leading-6 ${state().loading ? "text-slate-400" : "text-slate-500"}`}
                    role={state().loading ? "status" : undefined}
                  >
                    {state().loading
                      ? "Loading directories…"
                      : "Choose Home or retry this location to browse the runner."}
                  </p>
                }
                when={state().listing}
              >
                {(listing) => (
                  <Show
                    fallback={
                      <p class="grid min-h-32 place-items-center px-5 text-center text-sm text-slate-500">
                        This directory has no subdirectories.
                      </p>
                    }
                    when={listing().directories.length > 0}
                  >
                    <ul class="max-h-72 space-y-1 overflow-y-auto p-2">
                      <For each={listing().directories}>
                        {(directory) => (
                          <li>
                            <button
                              class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-slate-200 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-50"
                              data-directory-path={directory.path}
                              disabled={state().loading}
                              onClick={() => {
                                browse(directory.path);
                              }}
                              type="button"
                            >
                              <span aria-hidden="true" class="text-amber-200">
                                ▸
                              </span>
                              <span class="path-wrap min-w-0">
                                {directory.name}
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                )}
              </Show>
              <Show when={state().loading && state().listing !== undefined}>
                <p
                  class="absolute inset-x-0 bottom-0 bg-slate-950/90 px-3 py-2 text-center text-xs text-slate-400"
                  role="status"
                >
                  Opening directory…
                </p>
              </Show>
            </div>
            <Show when={state().listing?.truncated === true}>
              <p class="mt-3 text-xs leading-5 text-amber-200">
                Only the first {MAXIMUM_RUNNER_DIRECTORY_ENTRIES} directories
                are shown.
              </p>
            </Show>
          </div>

          <div class="flex flex-col-reverse items-stretch justify-end gap-2 border-t border-white/10 p-4 sm:flex-row sm:items-center sm:gap-3 sm:px-6 sm:py-5">
            <button
              class="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-white/20 hover:text-white"
              onClick={close}
              type="button"
            >
              Cancel
            </button>
            <button
              class="rounded-xl bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={state().listing === undefined || state().loading}
              onClick={props.onChoose}
              type="button"
            >
              Choose this directory
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
