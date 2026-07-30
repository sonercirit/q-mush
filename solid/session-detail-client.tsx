import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  type JSX,
} from "solid-js";
import { reasoningEffortLabel } from "../shared/agent-configuration.ts";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  activeSessionDuration,
  formatSessionTime,
} from "../shared/session-timing.ts";
import { Collection } from "./collection.tsx";
import { createLiveNow } from "./live-now.ts";
import { sessionContextLabel } from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { SessionDetailBody } from "./session-detail-body.tsx";
import type {
  LoadedSessionDetailViewProps,
  SessionDetailViewProps,
} from "./session-detail-view-props.ts";
import {
  discoverProviderUpdateModels,
  discoverProviderUpdateProviders,
  updateSessionProvider,
} from "./session-provider-update-controller.ts";
import type { SessionProviderUpdateDraft } from "./session-provider-update-model.ts";

const STATUS_PRESENTATION: Readonly<
  Record<
    AgentSessionStatus,
    { readonly classes: string; readonly label: string }
  >
> = {
  failed: {
    classes: "border-rose-300/20 bg-rose-300/10 text-rose-200",
    label: "Failed",
  },
  idle: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Ready",
  },
  paused: {
    classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
    label: "Restarting",
  },
  queued: {
    classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    label: "Queued",
  },
  running: {
    classes: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
    label: "Running",
  },
  stopped: {
    classes: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    label: "Stopped",
  },
};

function statusBadge(
  session: Pick<
    AgentSessionSummary,
    "pendingQuestions" | "runnerRequired" | "status"
  >,
): JSX.Element {
  const presentation =
    session.pendingQuestions !== null
      ? {
          classes: "border-violet-300/20 bg-violet-300/10 text-violet-200",
          label: "Waiting for answers",
        }
      : session.runnerRequired
        ? {
            classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
            label: "Choose runner",
          }
        : STATUS_PRESENTATION[session.status];
  return (
    <span
      class={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      {presentation.label}
    </span>
  );
}

function executionEnvironmentLabel(
  environment: AgentSessionSummary["executionEnvironment"],
): string {
  return environment === "container" ? "Container" : "Bare Metal";
}

function sessionModelLabel(
  session: Pick<AgentSessionSummary, "model" | "provider" | "reasoningEffort">,
): string {
  const model = `${session.provider} · ${session.model}`;
  return session.reasoningEffort === null
    ? model
    : `${model} · ${reasoningEffortLabel(session.reasoningEffort)} reasoning`;
}

function formatSessionCost(costUsd: number): string {
  if (costUsd === 0) {
    return "$0.00";
  }
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function sessionCostText(
  session: Pick<AgentSessionSummary, "costBasis" | "costUsd">,
): string {
  switch (session.costBasis) {
    case "estimated":
      return `Estimated cost: ${formatSessionCost(session.costUsd)}`;
    case "none":
      return "Cost: Not available";
    case "reported":
      return `Cost: ${formatSessionCost(session.costUsd)}`;
  }
}

function SessionMetrics(props: {
  readonly session: Pick<
    AgentSessionSummary,
    "activeDurationMs" | "activeStartedAt" | "costBasis" | "costUsd"
  >;
}): JSX.Element {
  const now = createLiveNow(() => props.session.activeStartedAt !== null);

  return (
    <span class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      <span>
        {`Time: ${formatSessionTime(activeSessionDuration(props.session, now()))}`}
      </span>
      <span>{sessionCostText(props.session)}</span>
    </span>
  );
}

const SESSION_PAGE_SIZE = 10;
const SESSION_SCROLL_LOAD_THRESHOLD = 64;

interface SessionHierarchy {
  readonly children: ReadonlyMap<string, readonly AgentSessionSummary[]>;
  readonly roots: readonly AgentSessionSummary[];
}

interface SessionListRow {
  readonly childCount: number;
  readonly depth: number;
  readonly session: AgentSessionSummary;
}

function sessionHierarchy(
  sessions: readonly AgentSessionSummary[],
): SessionHierarchy {
  const ids = new Set(sessions.map(({ id }) => id));
  const children = new Map<string, AgentSessionSummary[]>();
  const roots: AgentSessionSummary[] = [];
  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (parentId === null || parentId === session.id || !ids.has(parentId)) {
      roots.push(session);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(session);
    children.set(parentId, siblings);
  }

  const reachable = new Set<string>();
  const markReachable = (session: AgentSessionSummary): void => {
    if (reachable.has(session.id)) return;
    reachable.add(session.id);
    for (const child of children.get(session.id) ?? []) {
      markReachable(child);
    }
  };
  for (const root of roots) markReachable(root);
  for (const session of sessions) {
    if (!reachable.has(session.id)) {
      roots.push(session);
      markReachable(session);
    }
  }
  return { children, roots };
}

function visibleSessionRows(
  hierarchy: SessionHierarchy,
  roots: readonly AgentSessionSummary[],
  collapsed: ReadonlySet<string>,
): readonly SessionListRow[] {
  const rows: SessionListRow[] = [];
  const visited = new Set<string>();
  const append = (session: AgentSessionSummary, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    const children = hierarchy.children.get(session.id) ?? [];
    rows.push({ childCount: children.length, depth, session });
    if (!collapsed.has(session.id)) {
      for (const child of children) append(child, depth + 1);
    }
  };
  for (const root of roots) append(root, 0);
  return rows;
}

export function SessionList(props: {
  readonly controller: SessionController;
  readonly onSelect?: () => void;
}): JSX.Element {
  const state = createMemo(() => props.controller.view());
  const [visibleCount, setVisibleCount] = createSignal(SESSION_PAGE_SIZE);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const sessionSummaries = createMemo(() => state().sessions);
  const hierarchy = createMemo(() =>
    sessionHierarchy(sessionSummaries() ?? []),
  );
  const selectedId = createMemo(() => state().selectedId);
  const hasMoreSessions = createMemo(
    () => visibleCount() < hierarchy().roots.length,
  );
  const rootRevision = createMemo(() =>
    hierarchy()
      .roots.map(({ id }) => id)
      .toSorted()
      .join("\n"),
  );
  const sessions = createMemo(() => {
    const tree = hierarchy();
    return visibleSessionRows(
      tree,
      tree.roots.slice(0, visibleCount()),
      collapsed(),
    );
  });
  const loadMore = (): void => {
    setVisibleCount((current) =>
      Math.min(hierarchy().roots.length, current + SESSION_PAGE_SIZE),
    );
  };
  const loadMoreOnScroll: JSX.EventHandler<HTMLUListElement, Event> = (
    event,
  ) => {
    const list = event.currentTarget;
    if (
      hasMoreSessions() &&
      list.scrollHeight - list.clientHeight - list.scrollTop <=
        SESSION_SCROLL_LOAD_THRESHOLD
    ) {
      loadMore();
    }
  };
  const toggleChildren = (sessionId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  createEffect((previousRootRevision: string | undefined) => {
    const currentRootRevision = rootRevision();
    if (
      previousRootRevision !== undefined &&
      previousRootRevision !== currentRootRevision
    ) {
      setVisibleCount(SESSION_PAGE_SIZE);
    }
    return currentRootRevision;
  });

  return (
    <>
      <Collection
        empty={
          <p class="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
            No sessions yet. Start one above to give an agent a task.
          </p>
        }
        items={sessions()}
        listClass="session-list-items min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5"
        listProps={{ onScroll: loadMoreOnScroll }}
        loading={<p class="text-sm text-slate-400">Loading sessions…</p>}
        trailing={
          <Show when={hasMoreSessions()}>
            <li class="flex justify-center pt-1">
              <button
                class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200"
                data-load-more-sessions="true"
                onClick={loadMore}
                type="button"
              >
                Load more
              </button>
            </li>
          </Show>
        }
      >
        {(row) => {
          const session = row.session;
          return (
            <li
              class={
                row.depth === 0
                  ? undefined
                  : "border-l border-emerald-300/20 pl-2"
              }
              data-session-depth={row.depth}
              style={{ "margin-left": `${String(row.depth * 0.75)}rem` }}
            >
              <div class="flex items-stretch gap-1.5">
                <button
                  aria-current={
                    selectedId() === session.id ? "true" : undefined
                  }
                  class={`session-list-item min-h-11 min-w-0 flex-1 rounded-2xl border p-3 text-left transition sm:p-4 ${selectedId() === session.id ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
                  data-session-id={session.id}
                  onClick={() => {
                    props.onSelect?.();
                    void props.controller.select(session.id);
                  }}
                  type="button"
                >
                  <span class="flex items-start justify-between gap-3">
                    <span class="min-w-0 flex-1">
                      <span class="session-list-title block min-w-0 break-words font-semibold text-white">
                        {session.title}
                      </span>
                      <span class="session-list-meta mt-1 block min-w-0 break-words text-xs leading-5 text-slate-500">
                        {`${sessionModelLabel(session)} · ${executionEnvironmentLabel(session.executionEnvironment)}`}
                      </span>
                      <span class="mt-2 block">
                        <SessionMetrics session={session} />
                      </span>
                    </span>
                    {statusBadge(session)}
                  </span>
                </button>
                <Show when={row.childCount > 0}>
                  <button
                    aria-expanded={!collapsed().has(session.id)}
                    aria-label={`${collapsed().has(session.id) ? "Expand" : "Collapse"} child sessions for ${session.title}`}
                    class="w-8 shrink-0 rounded-xl border border-white/10 text-xs font-semibold text-slate-400 transition hover:border-emerald-300/30 hover:text-emerald-200"
                    onClick={() => {
                      toggleChildren(session.id);
                    }}
                    type="button"
                  >
                    {collapsed().has(session.id) ? "+" : "−"}
                  </button>
                </Show>
              </div>
            </li>
          );
        }}
      </Collection>
    </>
  );
}

function LoadedSessionDetail(props: LoadedSessionDetailViewProps): JSX.Element {
  const providerUpdate = () => ({
    credentials: props.credentials.map(({ credential, provider }) => ({
      ...credential,
      provider,
    })),
    onApply: async (selection: SessionProviderUpdateDraft) => {
      const updated = await updateSessionProvider({
        confirmed: true,
        detail: props.detail,
        selection,
        transport: props.controller.transport,
      });
      props.controller.applyDetail(updated);
      return true;
    },
    onDiscoverModels: (
      provider: AgentSessionSummary["provider"],
      credentialId: string,
    ) =>
      discoverProviderUpdateModels(
        props.controller.transport,
        provider,
        credentialId,
      ),
    onDiscoverProviders: (credentialId: string, model: string) =>
      discoverProviderUpdateProviders(
        credentialId,
        model,
        props.detail.workspaceId,
      ),
  });
  return (
    <SessionDetailBody
      contextLabel={sessionContextLabel(props.detail)}
      environmentLabel={executionEnvironmentLabel(
        props.detail.executionEnvironment,
      )}
      modelLabel={sessionModelLabel(props.detail)}
      presentation={statusBadge(props.detail)}
      providerUpdate={providerUpdate()}
      sessionMetrics={<SessionMetrics session={props.detail} />}
      view={props}
    />
  );
}

export function SessionDetail(props: SessionDetailViewProps): JSX.Element {
  return (
    <Show
      fallback={
        <div class="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-500">
          Select a session to view its transcript.
        </div>
      }
      when={props.state.selectedId}
    >
      <Show
        fallback={<p class="text-sm text-slate-400">Loading transcript…</p>}
        when={props.state.loadingDetail ? undefined : props.state.detail}
      >
        {(detail) => (
          <LoadedSessionDetail
            {...props}
            credentialAvailable={props.credentialAvailable}
            detail={detail()}
          />
        )}
      </Show>
    </Show>
  );
}
