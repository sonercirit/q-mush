import { type JSX } from "solid-js";
import { MAXIMUM_RUNNER_DIRECTORY_ENTRIES } from "../shared/runner-directory-model.ts";
import type { DirectoryPickerState } from "./directory-picker-controller.ts";
import { renderDebugBoundary } from "./render-debug.tsx";

function renderDirectoryContents(state: DirectoryPickerState): JSX.Element {
  const listing = state.listing;

  if (listing === undefined) {
    return state.loading ? (
      <p
        class="grid min-h-48 place-items-center text-sm text-slate-400"
        role="status"
      >
        Loading directories…
      </p>
    ) : (
      <p class="grid min-h-48 place-items-center px-5 text-center text-sm leading-6 text-slate-500">
        Choose Home or retry this location to browse the runner.
      </p>
    );
  }

  if (listing.directories.length === 0) {
    return (
      <p class="grid min-h-32 place-items-center px-5 text-center text-sm text-slate-500">
        This directory has no subdirectories.
      </p>
    );
  }

  const directoryItems = listing.directories.map((directory) => (
    <li>
      <button
        class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-slate-200 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-50"
        data-action="browse-directory"
        data-directory-path={directory.path}
        disabled={state.loading}
        type="button"
      >
        <span aria-hidden="true" class="text-amber-200">
          ▸
        </span>
        <span class="min-w-0 truncate">{directory.name}</span>
      </button>
    </li>
  ));

  return (
    <ul
      class="max-h-72 space-y-1 overflow-y-auto p-2"
      data-scroll-key={`directory-picker:${listing.path}`}
    >
      {directoryItems}
    </ul>
  );
}

function renderOpenDirectoryPicker(
  state: DirectoryPickerState,
  runnerName: string,
): JSX.Element {
  const listing = state.listing;
  const parent = listing?.parent;
  return (
    <div
      aria-labelledby="directory-picker-title"
      aria-modal="true"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
      data-directory-picker="true"
      role="dialog"
      tabindex="-1"
    >
      <div
        class="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/60"
        {...renderDebugBoundary("directory-picker", "Directory picker")}
      >
        <div class="flex items-start justify-between gap-4 border-b border-white/10 p-5 sm:p-6">
          <div class="min-w-0">
            <p class="text-xs font-semibold tracking-wider text-emerald-300 uppercase">
              {runnerName}
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
            data-action="close-directory-picker"
            type="button"
          >
            ×
          </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
          <div class="flex flex-wrap items-center gap-2">
            <button
              class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
              data-action="browse-home-directory"
              disabled={state.loading}
              type="button"
            >
              Home
            </button>
            <button
              class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
              data-action="browse-parent-directory"
              disabled={state.loading || typeof parent !== "string"}
              type="button"
            >
              Up
            </button>
            <code
              class="min-w-0 flex-1 truncate rounded-lg bg-slate-950 px-3 py-2 text-xs text-cyan-200"
              title={listing?.path ?? state.requestedPath ?? ""}
            >
              {listing?.path ?? state.requestedPath ?? "Select a location"}
            </code>
          </div>

          {state.error === undefined ? null : (
            <div
              class="mt-4 flex items-center justify-between gap-4 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100"
              role="alert"
            >
              <span>{state.error}</span>
              <button
                class="shrink-0 font-semibold underline underline-offset-4"
                data-action="retry-directory-picker"
                type="button"
              >
                Retry
              </button>
            </div>
          )}

          <div class="relative mt-4 min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
            {renderDirectoryContents(state)}
            {state.loading && listing !== undefined ? (
              <p
                class="absolute inset-x-0 bottom-0 bg-slate-950/90 px-3 py-2 text-center text-xs text-slate-400"
                role="status"
              >
                Opening directory…
              </p>
            ) : null}
          </div>
          {listing?.truncated === true ? (
            <p class="mt-3 text-xs leading-5 text-amber-200">
              Only the first {MAXIMUM_RUNNER_DIRECTORY_ENTRIES} directories are
              shown.
            </p>
          ) : null}
        </div>

        <div class="flex items-center justify-end gap-3 border-t border-white/10 p-5 sm:px-6">
          <button
            class="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-white/20 hover:text-white"
            data-action="close-directory-picker"
            type="button"
          >
            Cancel
          </button>
          <button
            class="rounded-xl bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
            data-action="choose-directory"
            disabled={listing === undefined || state.loading}
            type="button"
          >
            Choose this directory
          </button>
        </div>
      </div>
    </div>
  );
}

export function renderDirectoryPicker(
  state: DirectoryPickerState,
  runnerName: string,
): JSX.Element {
  return state.open ? renderOpenDirectoryPicker(state, runnerName) : null;
}
