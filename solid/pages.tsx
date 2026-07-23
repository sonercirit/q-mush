import { type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import {
  APP_PATH,
  APP_SCRIPT_PATH,
  FAVICON_PATH,
  STYLESHEET_PATH,
} from "../shared/routes.ts";

function renderSummaryItem(term: string, description: string): JSX.Element {
  return (
    <div class="flex items-center justify-between py-4">
      <dt class="text-sm text-slate-400">{term}</dt>
      <dd class="text-sm font-medium text-slate-200">{description}</dd>
    </div>
  );
}

function renderDocument(title: string, body: JSX.Element[]): string {
  const document = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#020617" />
        <title>{title}</title>
        <link rel="icon" href={FAVICON_PATH} type="image/svg+xml" />
        <link href={STYLESHEET_PATH} rel="stylesheet" />
      </head>
      <body class="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {body}
      </body>
    </html>
  );

  return `<!doctype html>${renderToString(() => document)}`;
}

export function renderHomePage(): string {
  return renderDocument("Q Mush", [
    <main class="relative isolate flex min-h-screen items-center overflow-hidden px-6 py-16 sm:px-10 lg:px-16">
      <div
        aria-hidden="true"
        class="absolute -left-40 top-1/4 -z-10 size-96 rounded-full bg-emerald-500/20 blur-3xl"
      ></div>
      <div
        aria-hidden="true"
        class="absolute -right-32 bottom-0 -z-10 size-96 rounded-full bg-cyan-500/15 blur-3xl"
      ></div>
      <div class="mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
        <section aria-labelledby="home-title">
          <p class="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-sm font-medium text-emerald-200">
            <span
              aria-hidden="true"
              class="size-2 rounded-full bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.9)]"
            ></span>
            Local agents, ready
          </p>
          <h1
            id="home-title"
            class="max-w-3xl bg-gradient-to-br from-white via-emerald-100 to-cyan-300 bg-clip-text text-6xl font-semibold tracking-tight text-balance text-transparent sm:text-7xl lg:text-8xl"
          >
            Q Mush
          </h1>
          <p class="mt-7 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl">
            A local-first distributed agent swarm harness.
          </p>
          <p class="mt-3 max-w-xl leading-7 text-slate-400">
            Grow capable agent teams on your machine and keep their work close
            to home.
          </p>
          <div class="mt-10 flex flex-wrap items-center gap-5">
            <a
              class="group inline-flex items-center gap-3 rounded-full bg-emerald-300 px-6 py-3 font-semibold text-slate-950 shadow-lg shadow-emerald-950/40 transition hover:bg-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
              href={APP_PATH}
            >
              Open the app
              <span
                aria-hidden="true"
                class="transition-transform group-hover:translate-x-1"
              >
                →
              </span>
            </a>
            <span class="text-sm text-slate-500">
              Private by default · no cloud required
            </span>
          </div>
        </section>

        <aside
          aria-label="System summary"
          class="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/40 backdrop-blur-xl sm:p-8"
        >
          <div class="flex items-center gap-4">
            <span
              aria-hidden="true"
              class="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-3xl shadow-lg shadow-emerald-950/50"
            >
              🍄
            </span>
            <div>
              <p class="text-sm font-medium text-slate-400">Swarm status</p>
              <p class="mt-1 flex items-center gap-2 font-semibold text-white">
                <span
                  aria-hidden="true"
                  class="size-2 rounded-full bg-emerald-300"
                ></span>
                Ready on this machine
              </p>
            </div>
          </div>
          <dl class="mt-8 divide-y divide-white/10 border-y border-white/10">
            {renderSummaryItem("Control plane", "Local")}
            {renderSummaryItem("Data boundary", "On device")}
            {renderSummaryItem("Runtime", "Bun")}
          </dl>
          <p class="mt-6 text-sm leading-6 text-slate-400">
            One quiet place to coordinate agents, inspect their progress, and
            stay in control.
          </p>
        </aside>
      </div>
    </main>,
  ]);
}

export function renderAppPage(): string {
  return renderDocument("Q Mush App", [
    <main id="app" class="min-h-screen"></main>,
    <script src={APP_SCRIPT_PATH} type="module"></script>,
    <noscript>
      <p class="m-6 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-amber-100">
        The Q Mush app needs JavaScript because this page is rendered in the
        browser.
      </p>
    </noscript>,
  ]);
}
