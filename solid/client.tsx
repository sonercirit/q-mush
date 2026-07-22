import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import {
  isRecord,
  type AuthenticatedUser,
  type AuthSession,
} from "../shared/auth-model.ts";
import {
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  HOME_PATH,
} from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";
import { providerNotice } from "./client-notices.ts";
import { updatePreservingFocus } from "./focus-position.ts";
import {
  BRAVE_SEARCH_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
  renderProviderPanel,
  type ProviderViewState,
} from "./provider-client.tsx";
import { ProviderController } from "./provider-controller.ts";
import { RealtimeConnection } from "./realtime-client.ts";
import { renderRunnerPanel, type RunnerViewState } from "./runner-client.tsx";
import { RunnerController } from "./runner-controller.ts";
import { updatePreservingScrollPositions } from "./scroll-position.ts";
import {
  renderSessionPanel,
  type SessionViewState,
} from "./session-client.tsx";
import { SessionController } from "./session-controller.ts";
import "./styles.css";

function readAuthenticatedUser(value: unknown): AuthenticatedUser | null {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error("The session contained an invalid user");
  }

  const email = value["email"];
  const id = value["id"];
  const name = value["name"];
  const picture = value["picture"];

  if (
    typeof email !== "string" ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    (picture !== undefined && typeof picture !== "string")
  ) {
    throw new Error("The session contained an invalid Google profile");
  }

  return picture === undefined
    ? { email, id, name }
    : { email, id, name, picture };
}

function readAuthSession(value: unknown): AuthSession {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid session");
  }

  const googleLoginAvailable = value["googleLoginAvailable"];

  if (typeof googleLoginAvailable !== "boolean") {
    throw new Error("The server returned an invalid login status");
  }

  return {
    googleLoginAvailable,
    user: readAuthenticatedUser(value["user"]),
  };
}

function readNotices(): readonly string[] {
  const url = new URL(window.location.href);
  const authResult = url.searchParams.get("auth");
  const openAiResult = url.searchParams.get("openai");
  const openRouterResult = url.searchParams.get("openrouter");
  const notices = [
    providerNotice("google", authResult),
    providerNotice("openai", openAiResult),
    providerNotice("openrouter", openRouterResult),
  ].filter((notice) => notice !== undefined);

  if (
    authResult !== null ||
    openAiResult !== null ||
    openRouterResult !== null
  ) {
    url.searchParams.delete("auth");
    url.searchParams.delete("openai");
    url.searchParams.delete("openrouter");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  return notices;
}

function renderAvatar(user: AuthenticatedUser): JSX.Element {
  if (user.picture !== undefined) {
    return (
      <img
        alt=""
        class="size-12 rounded-2xl bg-slate-800 object-cover ring-1 ring-white/10"
        referrerPolicy="no-referrer"
        src={user.picture}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      class="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-lg font-bold text-slate-950"
    >
      {user.name.charAt(0).toUpperCase()}
    </span>
  );
}

function renderHeader(user: AuthenticatedUser | null | undefined): JSX.Element {
  return (
    <header class="flex items-center justify-between gap-4 border-b border-white/10 pb-6">
      <a
        class="inline-flex items-center gap-3 rounded-full font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        href={HOME_PATH}
      >
        <span
          aria-hidden="true"
          class="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-xl shadow-lg shadow-emerald-950/50"
        >
          🍄
        </span>
        Q Mush
      </a>
      <span class="inline-flex min-w-0 items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
        <span
          aria-hidden="true"
          class="size-2 shrink-0 rounded-full bg-emerald-300"
        ></span>
        {user === undefined
          ? "Checking session"
          : user === null
            ? "Local runtime"
            : `Signed in as ${user.name}`}
      </span>
    </header>
  );
}

function renderLoadingCard(): JSX.Element {
  return (
    <div
      class="mt-12 rounded-3xl border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl"
      role="status"
    >
      <div class="flex items-center gap-4">
        <span
          aria-hidden="true"
          class="size-3 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.8)]"
        ></span>
        <p class="font-medium text-slate-200">Checking your session…</p>
      </div>
    </div>
  );
}

function renderSessionError(): JSX.Element {
  return (
    <div
      class="mt-12 rounded-3xl border border-rose-300/20 bg-rose-300/10 p-8"
      role="alert"
    >
      <p class="text-sm font-medium text-rose-200">Connection problem</p>
      <h2 class="mt-3 text-2xl font-semibold text-white">
        We could not check your session
      </h2>
      <p class="mt-3 max-w-xl leading-7 text-slate-300">
        Make sure the local server is running, then try again.
      </p>
      <button
        class="mt-7 rounded-full border border-white/15 px-5 py-2.5 font-semibold text-white transition hover:border-emerald-300/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        data-action="retry-session"
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

function renderSignIn(googleLoginAvailable: boolean): JSX.Element {
  return (
    <div class="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section
        aria-labelledby="sign-in-title"
        class="rounded-3xl border border-white/10 bg-white/[0.06] p-7 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-10"
      >
        <p class="text-sm font-medium text-emerald-300">Secure access</p>
        <h2
          class="mt-3 text-3xl font-semibold tracking-tight text-white"
          id="sign-in-title"
        >
          Sign in to your control center
        </h2>
        <p class="mt-4 max-w-xl leading-7 text-slate-400">
          Use your Google Account to identify yourself. Your Q Mush session
          remains on this machine.
        </p>
        {googleLoginAvailable ? (
          <a
            class="mt-8 inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-white px-5 py-3 font-semibold text-slate-900 shadow-lg shadow-black/20 transition hover:bg-slate-100 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 sm:w-auto"
            href={AUTH_GOOGLE_PATH}
          >
            <span
              aria-hidden="true"
              class="grid size-6 place-items-center rounded-full text-base font-bold text-[#4285f4] ring-1 ring-slate-200"
            >
              G
            </span>
            Continue with Google
          </a>
        ) : (
          <div class="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5 text-amber-100">
            <p class="font-medium">Google login needs configuration</p>
            <p class="mt-2 text-sm leading-6 text-amber-100/70">
              Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the local server,
              then restart it.
            </p>
          </div>
        )}
      </section>

      <aside
        aria-label="Login details"
        class="rounded-3xl border border-white/10 bg-slate-900/80 p-7 sm:p-8"
      >
        <span
          aria-hidden="true"
          class="grid size-12 place-items-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-xl"
        >
          🔐
        </span>
        <h2 class="mt-6 text-lg font-semibold text-white">
          A small identity boundary
        </h2>
        <ul class="mt-5 space-y-4 text-sm leading-6 text-slate-400">
          <li>Google verifies your account.</li>
          <li>Only your basic profile and email are requested.</li>
          <li>No Google access token is kept after sign-in.</li>
        </ul>
      </aside>
    </div>
  );
}

function renderWorkspace(
  braveSearchState: ProviderViewState,
  logoutPending: boolean,
  openAiState: ProviderViewState,
  openRouterState: ProviderViewState,
  runnerState: RunnerViewState,
  sessionState: SessionViewState,
  user: AuthenticatedUser,
): JSX.Element {
  return (
    <div class="mt-12 space-y-6">
      {renderSessionPanel(
        sessionState,
        runnerState,
        openAiState,
        openRouterState,
      )}
      {renderRunnerPanel(runnerState)}
      <aside
        aria-label="Google account"
        class="flex flex-col gap-5 rounded-3xl border border-white/10 bg-slate-900/80 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8"
      >
        <div class="flex min-w-0 items-center gap-4">
          {renderAvatar(user)}
          <div class="min-w-0">
            <p class="truncate font-semibold text-white">{user.name}</p>
            <p class="truncate text-sm text-slate-400">{user.email}</p>
          </div>
        </div>
        <button
          class="rounded-2xl border border-white/10 px-5 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          data-action="logout"
          disabled={logoutPending}
          type="button"
        >
          {logoutPending ? "Signing out…" : "Sign out"}
        </button>
      </aside>
      {renderProviderPanel(OPENAI_PANEL, openAiState)}
      {renderProviderPanel(OPENROUTER_PANEL, openRouterState)}
      {renderProviderPanel(BRAVE_SEARCH_PANEL, braveSearchState)}
    </div>
  );
}

function renderApp(
  braveSearchState: ProviderViewState,
  loadFailed: boolean,
  logoutPending: boolean,
  notices: readonly string[],
  openAiState: ProviderViewState,
  openRouterState: ProviderViewState,
  runnerState: RunnerViewState,
  sessionState: SessionViewState,
  session: AuthSession | undefined,
): JSX.Element {
  return (
    <section
      aria-labelledby="app-title"
      class="relative min-h-screen overflow-hidden bg-slate-950 px-6 py-8 text-slate-100 sm:px-10 lg:px-12"
    >
      <div
        aria-hidden="true"
        class="absolute -right-40 -top-40 size-96 rounded-full bg-cyan-500/15 blur-3xl"
      ></div>
      <div
        aria-hidden="true"
        class="absolute -bottom-48 left-1/4 size-96 rounded-full bg-emerald-500/15 blur-3xl"
      ></div>

      <div class="relative mx-auto max-w-6xl">
        {renderHeader(session?.user)}
        <main class="py-12 sm:py-16">
          <p class="text-sm font-semibold tracking-[0.2em] text-emerald-300 uppercase">
            Local control center
          </p>
          <h1
            class="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-6xl"
            id="app-title"
          >
            Q Mush App
          </h1>
          <p class="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
            Coordinate your local swarm from one authenticated workspace.
          </p>

          {notices.map((notice) => (
            <p
              class="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100"
              role="alert"
            >
              {notice}
            </p>
          ))}
          {loadFailed
            ? renderSessionError()
            : session === undefined
              ? renderLoadingCard()
              : session.user === null
                ? renderSignIn(session.googleLoginAvailable)
                : renderWorkspace(
                    braveSearchState,
                    logoutPending,
                    openAiState,
                    openRouterState,
                    runnerState,
                    sessionState,
                    session.user,
                  )}

          <a
            class="mt-10 inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            href={HOME_PATH}
          >
            <span aria-hidden="true">←</span>
            Back to the homepage
          </a>
        </main>
      </div>
    </section>
  );
}

function findAppRoot(): Element {
  const root = document.querySelector("#app");

  if (root === null) {
    throw new Error("The app root was not found");
  }

  return root;
}

const root = findAppRoot();
let appUpdateDeferred = false;
let disposeApp: (() => void) | undefined;
let loadFailed = false;
let logoutPending = false;
let session: AuthSession | undefined;
const notices = readNotices();
const braveSearch = new ProviderController(BRAVE_SEARCH_PANEL, () => {
  updateApp(root);
});
const openAi = new ProviderController(OPENAI_PANEL, () => {
  updateApp(root);
});
const openRouter = new ProviderController(OPENROUTER_PANEL, () => {
  updateApp(root);
});
const runners = new RunnerController(() => {
  updateApp(root);
});
const agentSessions = new SessionController(() => {
  updateApp(root);
});
const providerControllers = [openAi, openRouter, braveSearch] as const;
const realtime = new RealtimeConnection((event) => {
  switch (event.type) {
    case "runners":
      runners.applyRealtime(event.runners);
      break;
    case "sessions":
      agentSessions.applyRealtime(event.sessions);
      break;
    case "session":
      agentSessions.applyDetail(event.session);
      break;
    case "session_delta":
      agentSessions.applyDelta(event);
      break;
  }
});

function resetWorkspaceConnections(): void {
  realtime.stop();
  agentSessions.reset();
  runners.reset();
  for (const controller of providerControllers) {
    controller.reset();
  }
}

async function loadSession(): Promise<void> {
  loadFailed = false;
  session = undefined;
  resetWorkspaceConnections();
  updateApp(root);

  try {
    session = readAuthSession(await requestJson(AUTH_SESSION_PATH));

    if (session.user !== null) {
      await Promise.all([
        agentSessions.load(),
        runners.load(),
        ...providerControllers.map((controller) => controller.load()),
      ]);
      realtime.start();
    }
  } catch {
    loadFailed = true;
  }

  updateApp(root);
}

async function logout(): Promise<void> {
  logoutPending = true;
  updateApp(root);

  try {
    const response = await fetch(AUTH_LOGOUT_PATH, { method: "POST" });

    if (!response.ok) {
      throw new Error("The logout request failed");
    }

    resetWorkspaceConnections();
    session = {
      googleLoginAvailable: session?.googleLoginAvailable ?? true,
      user: null,
    };
  } catch {
    loadFailed = true;
    session = undefined;
  }

  logoutPending = false;
  updateApp(root);
}

function readScrollTargets(container: Element): ReadonlyMap<string, Element> {
  const targets = new Map<string, Element>();
  const ownerDocument = container.ownerDocument;

  targets.set(
    "document",
    ownerDocument.scrollingElement ?? ownerDocument.documentElement,
  );

  for (const element of container.querySelectorAll("[data-scroll-key]")) {
    const key = element.getAttribute("data-scroll-key");

    if (key !== null) {
      targets.set(`region:${key}`, element);
    }
  }

  return targets;
}

function focusKeySelector(key: string): string {
  return `[data-focus-key="${CSS.escape(key)}"]`;
}

function updateApp(container: Element, replaceFocusedSelect = false): void {
  const activeElement = container.ownerDocument.activeElement;

  if (
    !replaceFocusedSelect &&
    activeElement?.localName === "select" &&
    container.contains(activeElement)
  ) {
    appUpdateDeferred = true;
    return;
  }

  appUpdateDeferred = false;
  updatePreservingFocus(
    () => {
      const focused = container.ownerDocument.activeElement;
      return focused !== null && container.contains(focused) ? focused : null;
    },
    (key) => container.querySelector(focusKeySelector(key)),
    () => {
      updatePreservingScrollPositions(
        () => readScrollTargets(container),
        () => {
          disposeApp?.();
          disposeApp = render(
            () =>
              renderApp(
                braveSearch.state,
                loadFailed,
                logoutPending,
                notices,
                openAi.state,
                openRouter.state,
                runners.state,
                agentSessions.state,
                session,
              ),
            container,
          );
        },
      );
    },
  );
  agentSessions.bind(container);
  runners.bind(container);
  for (const controller of providerControllers) {
    controller.bind(container);
  }

  container
    .querySelector('[data-action="retry-session"]')
    ?.addEventListener("click", () => {
      void loadSession();
    });
  container
    .querySelector('[data-action="logout"]')
    ?.addEventListener("click", () => {
      void logout();
    });
}

function flushDeferredUpdateAfterSelect(
  event: Event,
  replaceFocusedSelect: boolean,
): void {
  if (event.target instanceof Element && event.target.localName === "select") {
    window.setTimeout(() => {
      if (appUpdateDeferred) {
        updateApp(root, replaceFocusedSelect);
      }
    }, 0);
  }
}

root.addEventListener("change", (event) => {
  flushDeferredUpdateAfterSelect(event, true);
});
root.addEventListener("focusout", (event) => {
  flushDeferredUpdateAfterSelect(event, false);
});

updateApp(root);
void loadSession();
