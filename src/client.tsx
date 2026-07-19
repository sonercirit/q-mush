import {
  isRecord,
  type AuthenticatedUser,
  type AuthSession,
} from "./auth-model.ts";
import { requestJson } from "./browser-http.ts";
import { providerNotice } from "./client-notices.ts";
import { createElement, mount, type JsxNode } from "./jsx.ts";
import {
  renderOpenRouterPanel,
  type OpenRouterViewState,
} from "./openrouter-client.tsx";
import { OpenRouterController } from "./openrouter-controller.ts";
import {
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  HOME_PATH,
} from "./routes.ts";

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
  const openRouterResult = url.searchParams.get("openrouter");
  const notices = [
    providerNotice("google", authResult),
    providerNotice("openrouter", openRouterResult),
  ].filter((notice) => notice !== undefined);

  if (authResult !== null || openRouterResult !== null) {
    url.searchParams.delete("auth");
    url.searchParams.delete("openrouter");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  return notices;
}

function renderAvatar(user: AuthenticatedUser): JsxNode {
  if (user.picture !== undefined) {
    return (
      <img
        alt=""
        className="size-12 rounded-2xl bg-slate-800 object-cover ring-1 ring-white/10"
        referrerpolicy="no-referrer"
        src={user.picture}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-lg font-bold text-slate-950"
    >
      {user.name.charAt(0).toUpperCase()}
    </span>
  );
}

function renderHeader(user: AuthenticatedUser | null | undefined): JsxNode {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-6">
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
      <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-emerald-300"
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

function renderLoadingCard(): JsxNode {
  return (
    <div
      className="mt-12 rounded-3xl border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl"
      role="status"
    >
      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="size-3 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.8)]"
        ></span>
        <p className="font-medium text-slate-200">Checking your session…</p>
      </div>
    </div>
  );
}

function renderSessionError(): JsxNode {
  return (
    <div
      className="mt-12 rounded-3xl border border-rose-300/20 bg-rose-300/10 p-8"
      role="alert"
    >
      <p className="text-sm font-medium text-rose-200">Connection problem</p>
      <h2 className="mt-3 text-2xl font-semibold text-white">
        We could not check your session
      </h2>
      <p className="mt-3 max-w-xl leading-7 text-slate-300">
        Make sure the local server is running, then try again.
      </p>
      <button
        className="mt-7 rounded-full border border-white/15 px-5 py-2.5 font-semibold text-white transition hover:border-emerald-300/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        data-action="retry-session"
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

function renderSignIn(googleLoginAvailable: boolean): JsxNode {
  return (
    <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section
        aria-labelledby="sign-in-title"
        className="rounded-3xl border border-white/10 bg-white/[0.06] p-7 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-10"
      >
        <p className="text-sm font-medium text-emerald-300">Secure access</p>
        <h2
          className="mt-3 text-3xl font-semibold tracking-tight text-white"
          id="sign-in-title"
        >
          Sign in to your control center
        </h2>
        <p className="mt-4 max-w-xl leading-7 text-slate-400">
          Use your Google Account to identify yourself. Your Q Mush session
          remains on this machine.
        </p>
        {googleLoginAvailable ? (
          <a
            className="mt-8 inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-white px-5 py-3 font-semibold text-slate-900 shadow-lg shadow-black/20 transition hover:bg-slate-100 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 sm:w-auto"
            href={AUTH_GOOGLE_PATH}
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-full text-base font-bold text-[#4285f4] ring-1 ring-slate-200"
            >
              G
            </span>
            Continue with Google
          </a>
        ) : (
          <div className="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5 text-amber-100">
            <p className="font-medium">Google login needs configuration</p>
            <p className="mt-2 text-sm leading-6 text-amber-100/70">
              Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the local server,
              then restart it.
            </p>
          </div>
        )}
      </section>

      <aside
        aria-label="Login details"
        className="rounded-3xl border border-white/10 bg-slate-900/80 p-7 sm:p-8"
      >
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-xl"
        >
          🔐
        </span>
        <h2 className="mt-6 text-lg font-semibold text-white">
          A small identity boundary
        </h2>
        <ul className="mt-5 space-y-4 text-sm leading-6 text-slate-400">
          <li>Google verifies your account.</li>
          <li>Only your basic profile and email are requested.</li>
          <li>No Google access token is kept after sign-in.</li>
        </ul>
      </aside>
    </div>
  );
}

function renderWorkspace(
  actionCount: number,
  logoutPending: boolean,
  openRouterState: OpenRouterViewState,
  user: AuthenticatedUser,
): JsxNode {
  return (
    <div className="mt-12 space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          aria-labelledby="agent-action-title"
          className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
        >
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-sm font-medium text-emerald-300">
                Agent action
              </p>
              <h2
                className="mt-3 text-2xl font-semibold text-white"
                id="agent-action-title"
              >
                Wake the swarm
              </h2>
              <p className="mt-3 max-w-xl leading-7 text-slate-400">
                Send a local signal through the harness and watch this session
                update instantly.
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
            data-action="run-agent"
            type="button"
          >
            Run an action
          </button>
        </section>

        <aside
          aria-label="Google account and session activity"
          className="rounded-3xl border border-white/10 bg-slate-900/80 p-6 sm:p-8"
        >
          <div className="flex min-w-0 items-center gap-4">
            {renderAvatar(user)}
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{user.name}</p>
              <p className="truncate text-sm text-slate-400">{user.email}</p>
            </div>
          </div>
          <p className="mt-6 text-sm font-medium text-slate-400">
            Session activity
          </p>
          <p
            aria-live="polite"
            className="mt-3 text-5xl font-semibold tracking-tight text-white"
          >
            {actionCount}
          </p>
          <p className="mt-2 text-sm text-slate-400">
            Actions run this session
          </p>
          <button
            className="mt-7 w-full rounded-2xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            data-action="logout"
            disabled={logoutPending}
            type="button"
          >
            {logoutPending ? "Signing out…" : "Sign out"}
          </button>
        </aside>
      </div>
      {renderOpenRouterPanel(openRouterState)}
    </div>
  );
}

function renderApp(
  actionCount: number,
  loadFailed: boolean,
  logoutPending: boolean,
  notices: readonly string[],
  openRouterState: OpenRouterViewState,
  session: AuthSession | undefined,
): JsxNode {
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
        {renderHeader(session?.user)}
        <main className="py-12 sm:py-16">
          <p className="text-sm font-semibold tracking-[0.2em] text-emerald-300 uppercase">
            Local control center
          </p>
          <h1
            className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-6xl"
            id="app-title"
          >
            Q Mush App
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
            Coordinate your local swarm from one authenticated workspace.
          </p>

          {notices.map((notice) => (
            <p
              className="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100"
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
                    actionCount,
                    logoutPending,
                    openRouterState,
                    session.user,
                  )}

          <a
            className="mt-10 inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
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
let actionCount = 0;
let loadFailed = false;
let logoutPending = false;
let session: AuthSession | undefined;
const notices = readNotices();
const openRouter = new OpenRouterController(() => {
  updateApp(root);
});

async function loadSession(): Promise<void> {
  loadFailed = false;
  session = undefined;
  openRouter.reset();
  updateApp(root);

  try {
    session = readAuthSession(await requestJson(AUTH_SESSION_PATH));

    if (session.user !== null) {
      await openRouter.load();
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

    actionCount = 0;
    openRouter.reset();
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

function updateApp(container: Element): void {
  mount(
    renderApp(
      actionCount,
      loadFailed,
      logoutPending,
      notices,
      openRouter.state,
      session,
    ),
    container,
  );
  openRouter.bind(container);

  container
    .querySelector('[data-action="run-agent"]')
    ?.addEventListener("click", () => {
      actionCount += 1;
      updateApp(container);
    });
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

updateApp(root);
void loadSession();
