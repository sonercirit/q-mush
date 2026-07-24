import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type { SessionController } from "./session-controller.ts";
import { SessionDetail, SessionList } from "./session-detail-client.tsx";

interface SessionResultsProps {
  readonly controller: SessionController;
  readonly credentialAvailable: boolean | undefined;
  readonly focusMode: Accessor<boolean>;
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly setFocusMode: (focused: boolean) => void;
}

export function SessionResults(props: SessionResultsProps): JSX.Element {
  const state = props.controller.view;
  const [listOpen, setListOpen] = createSignal(false);
  const [listPanel, setListPanel] = createSignal<HTMLElement>();
  const [detailShell, setDetailShell] = createSignal<HTMLDivElement>();
  const closeList = (): void => {
    setListOpen(false);
  };
  const focusDetailControl = (selector?: string): void => {
    queueMicrotask(() => {
      const shell = detailShell();
      const control =
        selector === undefined
          ? shell
          : shell?.querySelector<HTMLButtonElement>(selector);
      control?.focus({ preventScroll: true });
    });
  };
  const closeListAndFocusDetail = (): void => {
    closeList();
    focusDetailControl();
  };
  const leaveFocusMode = (): void => {
    closeList();
    props.setFocusMode(false);
    focusDetailControl("[data-session-focus-toggle='true']");
  };
  const toggleFocusMode = (): void => {
    if (props.focusMode()) {
      leaveFocusMode();
    } else {
      closeList();
      props.setFocusMode(true);
      focusDetailControl("[data-session-focus-toggle='true']");
    }
  };
  const openList = (): void => {
    if (props.focusMode()) {
      setListOpen(true);
    }
  };
  const focusFirstSession = (): void => {
    queueMicrotask(() => {
      listPanel()
        ?.querySelector<HTMLButtonElement>("[data-session-id]")
        ?.focus({ preventScroll: true });
    });
  };
  const toggleList = (): void => {
    if (listOpen()) {
      closeListAndFocusDetail();
    } else {
      openList();
      focusFirstSession();
    }
  };
  const selectSession = (): void => {
    if (props.focusMode()) {
      closeList();
      focusDetailControl();
    }
  };
  const closeOpenListAndFocusDetail = (): void => {
    if (props.focusMode() && listOpen()) {
      closeListAndFocusDetail();
    }
  };

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        !props.focusMode()
      ) {
        return;
      }

      event.preventDefault();
      if (listOpen()) {
        closeListAndFocusDetail();
      } else {
        leaveFocusMode();
      }
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOpenListAndFocusDetail);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeOpenListAndFocusDetail);
      document.body.classList.remove("session-focus-scroll-lock");
    });
  });

  createEffect(() => {
    document.body.classList.toggle(
      "session-focus-scroll-lock",
      props.focusMode(),
    );
  });

  return (
    <div
      class="session-results mt-7 grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]"
      data-session-focus-mode={String(props.focusMode())}
      data-session-results="true"
    >
      <div
        aria-hidden="true"
        class="session-list-edge-trigger"
        data-session-list-edge-trigger="true"
        data-session-list-open={String(listOpen())}
        onMouseEnter={openList}
      />
      <aside
        aria-hidden={props.focusMode() && !listOpen() ? "true" : undefined}
        aria-label="Agent sessions"
        class="session-list-panel min-w-0"
        data-session-list-open={String(listOpen())}
        data-session-list-panel="true"
        id="session-list-drawer"
        inert={props.focusMode() && !listOpen()}
        onMouseEnter={openList}
        onMouseLeave={closeOpenListAndFocusDetail}
        ref={setListPanel}
      >
        <div class="session-list-surface">
          <div class="session-list-heading">
            <span>Sessions</span>
            <button
              aria-label="Collapse session list"
              class="session-list-close"
              onClick={closeListAndFocusDetail}
              type="button"
            >
              ×
            </button>
          </div>
          <SessionList controller={props.controller} onSelect={selectSession} />
        </div>
      </aside>
      <button
        aria-label="Close session list"
        class="session-list-backdrop"
        data-session-list-backdrop="true"
        onClick={closeListAndFocusDetail}
        tabindex={listOpen() && props.focusMode() ? undefined : -1}
        type="button"
      />
      <div
        class="session-detail-shell min-w-0 rounded-2xl border border-white/10 bg-slate-900/70 p-3 sm:p-5"
        data-session-detail-shell="true"
        inert={listOpen() && props.focusMode()}
        ref={setDetailShell}
        tabindex="-1"
      >
        <div class="session-detail-toolbar mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <button
            aria-controls="session-list-drawer"
            aria-expanded={listOpen()}
            class="session-drawer-toggle min-h-11 rounded-xl border border-white/10 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
            data-session-drawer-toggle="true"
            onClick={toggleList}
            type="button"
          >
            <span aria-hidden="true">☰</span> Sessions
          </button>
          <button
            aria-pressed={props.focusMode()}
            class="min-h-11 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 sm:px-4"
            data-session-focus-toggle="true"
            disabled={state().selectedId === undefined}
            onClick={toggleFocusMode}
            type="button"
          >
            {props.focusMode() ? "Exit focus mode" : "Focus session"}
          </button>
        </div>
        <div
          class="session-detail-content min-h-0 min-w-0"
          data-session-detail-content="true"
        >
          <SessionDetail
            controller={props.controller}
            credentialAvailable={props.credentialAvailable}
            onOpenDirectoryPicker={props.onOpenDirectoryPicker}
            runners={props.runners}
            state={state()}
          />
        </div>
      </div>
    </div>
  );
}
