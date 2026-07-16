import { createElement, mount, type JsxNode } from "./jsx.ts";
import { HOME_PATH } from "./routes.ts";

function renderApp(actionCount: number): JsxNode {
  return (
    <section
      aria-labelledby="app-title"
      className="relative min-h-screen overflow-hidden bg-slate-950 px-6 py-8 text-slate-100 sm:px-10 lg:px-12"
    >
      <div
        aria-hidden="true"
        className="absolute -right-40 -top-40 size-96 rounded-full bg-cyan-500/15 blur-3xl"
      ></div>
      <div
        aria-hidden="true"
        className="absolute -bottom-48 left-1/4 size-96 rounded-full bg-emerald-500/15 blur-3xl"
      ></div>

      <div className="relative mx-auto max-w-6xl">
        <header className="flex items-center justify-between border-b border-white/10 pb-6">
          <a
            className="inline-flex items-center gap-3 rounded-full font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            href={HOME_PATH}
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-xl shadow-lg shadow-emerald-950/50"
            >
              🍄
            </span>
            Q Mush
          </a>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-emerald-300"
            ></span>
            Local runtime
          </span>
        </header>

        <div className="py-12 sm:py-16">
          <p className="text-sm font-semibold tracking-[0.2em] text-emerald-300 uppercase">
            Local control center
          </p>
          <h1
            id="app-title"
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-6xl"
          >
            Q Mush App
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
            This interface was rendered in your browser with framework-free TSX.
          </p>

          <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <p className="text-sm font-medium text-emerald-300">
                    Agent action
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold text-white">
                    Wake the swarm
                  </h2>
                  <p className="mt-3 max-w-xl leading-7 text-slate-400">
                    Send a local signal through the harness and watch this
                    session update instantly.
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className="grid size-12 shrink-0 place-items-center rounded-2xl border border-white/10 bg-slate-900 text-xl"
                >
                  ⚡
                </span>
              </div>
              <button
                className="mt-10 inline-flex w-full items-center justify-center rounded-2xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 shadow-lg shadow-emerald-950/40 transition hover:bg-emerald-200 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 sm:w-auto"
                type="button"
              >
                Run an action
              </button>
            </div>

            <aside
              aria-label="Session activity"
              className="rounded-3xl border border-white/10 bg-slate-900/80 p-6 sm:p-8"
            >
              <p className="text-sm font-medium text-slate-400">
                Session activity
              </p>
              <p
                aria-live="polite"
                className="mt-6 text-6xl font-semibold tracking-tight text-white"
              >
                {actionCount}
              </p>
              <p className="mt-2 text-sm text-slate-400">
                Actions run this session
              </p>
              <div className="mt-8 flex items-center gap-3 border-t border-white/10 pt-6 text-sm text-slate-300">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,0.8)]"
                ></span>
                Browser connection healthy
              </div>
            </aside>
          </div>

          <a
            className="mt-10 inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            href={HOME_PATH}
          >
            <span aria-hidden="true">←</span>
            Back to the homepage
          </a>
        </div>
      </div>
    </section>
  );
}

const root = document.querySelector("#app");

if (root === null) {
  throw new Error("The app root was not found");
}

let actionCount = 0;

function updateApp(container: Element): void {
  mount(renderApp(actionCount), container);

  const button = container.querySelector("button");

  if (button === null) {
    throw new Error("The app action button was not rendered");
  }

  button.addEventListener("click", () => {
    actionCount += 1;
    updateApp(container);
  });
}

updateApp(root);
