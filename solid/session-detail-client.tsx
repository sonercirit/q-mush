import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  type Accessor,
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
  completed: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Completed",
  },
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
  const stepStartedAt = (): number | null => props.session.activeStartedAt;

  return (
    <span class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      <span>
        {`Time: ${formatSessionTime(activeSessionDuration(props.session, now()))}`}
      </span>
      <Show when={stepStartedAt()} keyed>
        {(startedAt) => (
          <span class="text-emerald-300/80">
            {`Step: ${formatSessionTime(Math.max(0, now() - startedAt))}`}
          </span>
        )}
      </Show>
      <span>{sessionCostText(props.session)}</span>
    </span>
  );
}

const SESSION_PAGE_SIZE = 10;
const SESSION_SCROLL_LOAD_THRESHOLD = 64;

interface SessionHierarchy {
  readonly children: ReadonlyMap<string, readonly AgentSessionSummary[]>;
  readonly parentIds: ReadonlyMap<string, string>;
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
  const parentIds = new Map<string, string>();
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
    parentIds.set(session.id, parentId);
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
  return { children, parentIds, roots };
}

function visibleSessionRows(
  hierarchy: SessionHierarchy,
  roots: readonly AgentSessionSummary[],
  expanded: ReadonlySet<string>,
): readonly SessionListRow[] {
  const rows: SessionListRow[] = [];
  const visited = new Set<string>();
  const append = (session: AgentSessionSummary, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    const children = hierarchy.children.get(session.id) ?? [];
    rows.push({ childCount: children.length, depth, session });
    if (expanded.has(session.id)) {
      for (const child of children) append(child, depth + 1);
    }
  };
  for (const root of roots) append(root, 0);
  return rows;
}

function boundedSessionRows(
  rows: readonly SessionListRow[],
  limit: number,
  selectedId: string | undefined,
): readonly SessionListRow[] {
  if (rows.length <= limit) return rows;
  const selectedIndex = rows.findIndex(
    ({ session }) => session.id === selectedId,
  );
  if (selectedIndex < limit) return rows.slice(0, limit);

  const selectedPath: SessionListRow[] = [];
  let expectedDepth = rows[selectedIndex]?.depth ?? -1;
  for (
    let index = selectedIndex;
    index >= 0 && expectedDepth >= 0;
    index -= 1
  ) {
    const row = rows[index];
    if (row?.depth === expectedDepth) {
      selectedPath.push(row);
      expectedDepth -= 1;
    }
  }
  const requiredRows = selectedPath.reverse().slice(-limit);
  const requiredIds = new Set(requiredRows.map(({ session }) => session.id));
  const leadingRows = rows
    .slice(0, limit)
    .filter(({ session }) => !requiredIds.has(session.id))
    .slice(0, limit - requiredRows.length);
  const includedIds = new Set(
    [...leadingRows, ...requiredRows].map(({ session }) => session.id),
  );
  return rows.filter(({ session }) => includedIds.has(session.id));
}

function selectedAncestorIds(
  hierarchy: SessionHierarchy,
  selectedId: string | undefined,
): readonly string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let sessionId = selectedId;
  while (sessionId !== undefined && !visited.has(sessionId)) {
    visited.add(sessionId);
    const parentId = hierarchy.parentIds.get(sessionId);
    if (parentId === undefined) break;
    ancestors.push(parentId);
    sessionId = parentId;
  }
  return ancestors;
}

function sessionListRowMatches(
  left: SessionListRow,
  right: SessionListRow,
): boolean {
  const leftSession = left.session;
  const rightSession = right.session;
  return (
    left.childCount === right.childCount &&
    left.depth === right.depth &&
    leftSession.activeDurationMs === rightSession.activeDurationMs &&
    leftSession.activeStartedAt === rightSession.activeStartedAt &&
    leftSession.costBasis === rightSession.costBasis &&
    leftSession.costUsd === rightSession.costUsd &&
    leftSession.executionEnvironment === rightSession.executionEnvironment &&
    leftSession.id === rightSession.id &&
    leftSession.model === rightSession.model &&
    (leftSession.pendingQuestions === null) ===
      (rightSession.pendingQuestions === null) &&
    leftSession.provider === rightSession.provider &&
    leftSession.reasoningEffort === rightSession.reasoningEffort &&
    leftSession.runnerRequired === rightSession.runnerRequired &&
    leftSession.status === rightSession.status &&
    leftSession.title === rightSession.title
  );
}

function retainSessionListRows(
  previous: readonly SessionListRow[] | undefined,
  current: readonly SessionListRow[],
): readonly SessionListRow[] {
  if (previous === undefined) return current;
  const previousById = new Map(previous.map((row) => [row.session.id, row]));
  return current.map((row) => {
    const retained = previousById.get(row.session.id);
    return retained !== undefined && sessionListRowMatches(retained, row)
      ? retained
      : row;
  });
}

function SessionListItem(props: {
  readonly controller: SessionController;
  readonly expanded: Accessor<ReadonlySet<string>>;
  readonly onSelect: (() => void) | undefined;
  readonly onToggleChildren: (sessionId: string) => void;
  readonly row: SessionListRow;
  readonly selectedId: Accessor<string | undefined>;
}): JSX.Element {
  const session = (): AgentSessionSummary => props.row.session;
  const selected = (): boolean => props.selectedId() === session().id;
  return (
    <li
      class={
        props.row.depth === 0
          ? undefined
          : "border-l border-emerald-300/20 pl-2"
      }
      data-session-depth={props.row.depth}
      style={{ "margin-left": `${String(props.row.depth * 0.75)}rem` }}
    >
      <div class="flex items-stretch gap-1.5">
        <button
          aria-current={selected() ? "true" : undefined}
          class={`session-list-item min-h-11 min-w-0 flex-1 rounded-2xl border p-3 text-left transition sm:p-4 ${selected() ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
          data-session-id={session().id}
          onClick={() => {
            props.onSelect?.();
            void props.controller.select(session().id);
          }}
          type="button"
        >
          <span class="flex items-start justify-between gap-3">
            <span class="min-w-0 flex-1">
              <span class="session-list-title block min-w-0 break-words font-semibold text-white">
                {session().title}
              </span>
              <span class="session-list-meta mt-1 block min-w-0 break-words text-xs leading-5 text-slate-500">
                {`${sessionModelLabel(session())} · ${executionEnvironmentLabel(session().executionEnvironment)}`}
              </span>
              <span class="mt-2 block">
                <SessionMetrics session={session()} />
              </span>
            </span>
            {statusBadge(session())}
          </span>
        </button>
        <Show when={props.row.childCount > 0}>
          <button
            aria-expanded={props.expanded().has(session().id)}
            aria-label={`${props.expanded().has(session().id) ? "Collapse" : "Expand"} child sessions for ${session().title}`}
            class="shrink-0 rounded-xl border border-white/10 px-2 text-xs font-semibold text-slate-400 transition hover:border-emerald-300/30 hover:text-emerald-200"
            onClick={() => {
              props.onToggleChildren(session().id);
            }}
            type="button"
          >
            {`${props.expanded().has(session().id) ? "Collapse" : "Expand"} (${String(props.row.childCount)})`}
          </button>
        </Show>
      </div>
    </li>
  );
}

export function SessionList(props: {
  readonly controller: SessionController;
  readonly onSelect?: () => void;
}): JSX.Element {
  const state = createMemo(() => props.controller.view());
  const [visibleCount, setVisibleCount] = createSignal(SESSION_PAGE_SIZE);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const sessionSummaries = createMemo(() => state().sessions);
  const hierarchy = createMemo(() =>
    sessionHierarchy(sessionSummaries() ?? []),
  );
  const selectedId = createMemo(() => state().selectedId);
  const visibleRows = createMemo(
    (previous: readonly SessionListRow[] | undefined) => {
      const tree = hierarchy();
      return retainSessionListRows(
        previous,
        visibleSessionRows(tree, tree.roots, expanded()),
      );
    },
  );
  const hasMoreSessions = createMemo(
    () => visibleCount() < visibleRows().length,
  );
  const rootRevision = createMemo(() =>
    hierarchy()
      .roots.map(({ id }) => id)
      .toSorted()
      .join("\n"),
  );
  const sessions = createMemo(() =>
    boundedSessionRows(visibleRows(), visibleCount(), selectedId()),
  );
  const loadMore = (): void => {
    setVisibleCount((current) =>
      Math.min(visibleRows().length, current + SESSION_PAGE_SIZE),
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
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  createEffect(() => {
    const current = expanded();
    const ancestors = selectedAncestorIds(hierarchy(), selectedId());
    if (
      ancestors.length === 0 ||
      ancestors.every((sessionId) => current.has(sessionId))
    ) {
      return;
    }
    setExpanded(new Set([...current, ...ancestors]));
  });

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
        {(row) => (
          <SessionListItem
            controller={props.controller}
            expanded={expanded}
            onSelect={props.onSelect}
            onToggleChildren={toggleChildren}
            row={row}
            selectedId={selectedId}
          />
        )}
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
