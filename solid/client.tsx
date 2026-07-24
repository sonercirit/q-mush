import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
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
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { requestJson } from "./browser-http.ts";
import { providerNotice } from "./client-notices.ts";
import {
  BRAVE_SEARCH_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
} from "./provider-client.tsx";
import { ProviderController } from "./provider-controller.ts";
import { RealtimeConnection } from "./realtime-client.ts";
import {
  renderDebugBoundary,
  RenderDebugLegend,
  RenderDebugProvider,
  RenderDebugToggle,
  RenderDebugView,
} from "./render-debug.tsx";
import { RunnerController } from "./runner-controller.ts";
import { SessionController } from "./session-controller.ts";
import "./styles.css";
import { WorkspaceController } from "./workspace-controller.ts";
import { Workspace } from "./workspace-view.tsx";

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

function Header(props: {
  readonly debug: RenderDebugView;
  readonly user: AuthenticatedUser | null | undefined;
}): JSX.Element {
  return (
    <header
      class="flex min-w-0 flex-col gap-4 border-b border-white/10 pb-5 sm:pb-6 md:flex-row md:items-center md:justify-between"
      {...renderDebugBoundary("header", "Header")}
    >
      <a
        class="inline-flex items-center gap-3 self-start rounded-full font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
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
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <RenderDebugToggle view={props.debug} />
        <span class="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
          <span
            aria-hidden="true"
            class="size-2 shrink-0 rounded-full bg-emerald-300"
          />
          {props.user === undefined
            ? "Checking session"
            : props.user === null
              ? "Local runtime"
              : `Signed in as ${props.user.name}`}
        </span>
      </div>
    </header>
  );
}

function LoadingCard(): JSX.Element {
  return (
    <div
      class="mt-8 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:mt-12 sm:p-8"
      role="status"
    >
      <div class="flex items-center gap-4">
        <span
          aria-hidden="true"
          class="size-3 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.8)]"
        />
        <p class="font-medium text-slate-200">Checking your session…</p>
      </div>
    </div>
  );
}

function SessionError(props: { readonly onRetry: () => void }): JSX.Element {
  return (
    <div
      class="mt-8 rounded-3xl border border-rose-300/20 bg-rose-300/10 p-5 sm:mt-12 sm:p-8"
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
        onClick={props.onRetry}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

function SignIn(props: {
  readonly googleLoginAvailable: boolean;
}): JSX.Element {
  return (
    <div class="mt-8 grid min-w-0 gap-6 sm:mt-12 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section
        aria-labelledby="sign-in-title"
        class="min-w-0 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8 lg:p-10"
      >
        <p class="text-sm font-medium text-emerald-300">Secure access</p>
        <h2
          class="mt-3 text-2xl font-semibold tracking-tight break-words text-white sm:text-3xl"
          id="sign-in-title"
        >
          Sign in to your control center
        </h2>
        <p class="mt-4 max-w-xl leading-7 text-slate-400">
          Use your Google Account to identify yourself. Your Q Mush session
          remains on this machine.
        </p>
        <Show
          fallback={
            <div class="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5 text-amber-100">
              <p class="font-medium">Google login needs configuration</p>
              <p class="mt-2 text-sm leading-6 text-amber-100/70">
                Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the local
                server, then restart it.
              </p>
            </div>
          }
          when={props.googleLoginAvailable}
        >
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
        </Show>
      </section>
      <aside
        aria-label="Login details"
        class="min-w-0 rounded-3xl border border-white/10 bg-slate-900/80 p-5 sm:p-8"
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

function App(): JSX.Element {
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [logoutPending, setLogoutPending] = createSignal(false);
  const [session, setSession] = createSignal<AuthSession>();
  const notices = readNotices();
  const debug = new RenderDebugView();
  const braveSearch = new ProviderController(BRAVE_SEARCH_PANEL);
  const openAi = new ProviderController(OPENAI_PANEL);
  const openRouter = new ProviderController(OPENROUTER_PANEL);
  const runners = new RunnerController();
  const agentSessions = new SessionController();
  const providerControllers = [openAi, openRouter, braveSearch] as const;
  let scopedLoadRevision = 0;
  const reloadScopedData = (workspaceId: string): void => {
    const revision = ++scopedLoadRevision;
    realtime.stop();
    agentSessions.setWorkspace(workspaceId);
    runners.setWorkspace(workspaceId);
    for (const controller of providerControllers) {
      controller.setWorkspace(workspaceId);
    }
    if (workspaceId === GLOBAL_WORKSPACE_ID) {
      void Promise.all([
        runners.load(),
        ...providerControllers.map((controller) => controller.load()),
      ]).then(() => {
        if (revision === scopedLoadRevision) {
          realtime.start(workspaceId);
        }
      });
      return;
    }
    void Promise.all([
      agentSessions.load(),
      runners.load(),
      ...providerControllers.map((controller) => controller.load()),
    ]).then(() => {
      if (revision === scopedLoadRevision) {
        realtime.start(workspaceId);
      }
    });
  };
  const workspaces = new WorkspaceController(reloadScopedData);
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

  const resetWorkspaceConnections = (): void => {
    scopedLoadRevision += 1;
    realtime.stop();
    agentSessions.reset();
    workspaces.reset();
    runners.reset();
    for (const controller of providerControllers) {
      controller.reset();
    }
  };

  const loadSession = async (): Promise<void> => {
    setLoadFailed(false);
    setSession(undefined);
    resetWorkspaceConnections();

    try {
      const loaded = readAuthSession(await requestJson(AUTH_SESSION_PATH));
      setSession(loaded);
      if (loaded.user !== null) {
        await workspaces.load();
      }
    } catch {
      setLoadFailed(true);
    }
  };

  const logout = async (): Promise<void> => {
    setLogoutPending(true);
    try {
      const response = await fetch(AUTH_LOGOUT_PATH, { method: "POST" });
      if (!response.ok) {
        throw new Error("The logout request failed");
      }
      resetWorkspaceConnections();
      setSession({
        googleLoginAvailable: session()?.googleLoginAvailable ?? true,
        user: null,
      });
    } catch {
      setLoadFailed(true);
      setSession(undefined);
    } finally {
      setLogoutPending(false);
    }
  };

  onMount(() => {
    void loadSession();
  });
  onCleanup(resetWorkspaceConnections);

  return (
    <RenderDebugProvider view={debug}>
      <section
        aria-labelledby="app-title"
        class="relative min-h-screen overflow-x-clip bg-slate-950 px-3 py-5 text-slate-100 sm:px-6 sm:py-8 md:px-8 lg:px-10 xl:px-12"
        {...renderDebugBoundary("app", "App")}
      >
        <div
          aria-hidden="true"
          class="absolute -right-40 -top-40 size-96 rounded-full bg-cyan-500/15 blur-3xl"
        />
        <div
          aria-hidden="true"
          class="absolute -bottom-48 left-1/4 size-96 rounded-full bg-emerald-500/15 blur-3xl"
        />
        <div class="relative mx-auto min-w-0 max-w-[96rem]">
          <Header debug={debug} user={session()?.user} />
          <main class="min-w-0 py-8 sm:py-12 lg:py-16">
            <p class="text-sm font-semibold tracking-[0.2em] text-emerald-300 uppercase">
              Local control center
            </p>
            <h1
              class="mt-4 text-3xl font-semibold tracking-tight break-words text-white sm:text-5xl lg:text-6xl"
              id="app-title"
            >
              Q Mush App
            </h1>
            <p class="mt-5 max-w-2xl text-lg leading-8 text-slate-400">
              Coordinate your local swarm from one authenticated workspace.
            </p>
            <For each={notices}>
              {(notice) => (
                <p
                  class="mt-8 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100"
                  role="alert"
                >
                  {notice}
                </p>
              )}
            </For>
            <Show
              fallback={<LoadingCard />}
              when={loadFailed() || session() !== undefined}
            >
              <Show
                fallback={<SessionError onRetry={() => void loadSession()} />}
                when={!loadFailed()}
              >
                <Show when={session()}>
                  {(authenticated) => (
                    <Show
                      fallback={
                        <SignIn
                          googleLoginAvailable={
                            authenticated().googleLoginAvailable
                          }
                        />
                      }
                      when={authenticated().user}
                    >
                      {(user) => (
                        <Workspace
                          agentSessions={agentSessions}
                          braveSearch={braveSearch}
                          logout={logout}
                          logoutPending={logoutPending()}
                          openAi={openAi}
                          openRouter={openRouter}
                          runners={runners}
                          user={user()}
                          workspaces={workspaces}
                        />
                      )}
                    </Show>
                  )}
                </Show>
              </Show>
            </Show>
            <a
              class="mt-10 inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
              href={HOME_PATH}
            >
              <span aria-hidden="true">←</span>
              Back to the homepage
            </a>
          </main>
        </div>
        <RenderDebugLegend view={debug} />
      </section>
    </RenderDebugProvider>
  );
}

const root = document.getElementById("app");
if (root === null) {
  throw new Error("The app root was not found");
}

render(() => <App />, root);
