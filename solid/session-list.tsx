import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import type { SessionController } from "./session-controller.ts";
import {
  executionEnvironmentLabel,
  SessionMetrics,
  sessionModelLabel,
  statusBadge,
} from "./session-summary-presentation.tsx";

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

interface SessionListGroup {
  readonly children: readonly SessionListRow[];
  readonly root: SessionListRow;
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

function visibleSessionGroup(
  hierarchy: SessionHierarchy,
  root: AgentSessionSummary,
  expanded: ReadonlySet<string>,
): SessionListGroup {
  const rows = visibleSessionRows(hierarchy, [root], expanded);
  const first = rows[0];
  if (first === undefined) {
    throw new Error("A session group has no root");
  }
  return { children: rows.slice(1), root: first };
}

function boundedSessionGroups(
  hierarchy: SessionHierarchy,
  roots: readonly AgentSessionSummary[],
  expanded: ReadonlySet<string>,
  rootLimit: number,
  childLimit: number,
  selectedId: string | undefined,
): readonly SessionListGroup[] {
  const selectedAncestors = new Set(selectedAncestorIds(hierarchy, selectedId));
  const requiredRoot = roots.find(
    ({ id }) => id === selectedId || selectedAncestors.has(id),
  );
  const selectedRoots = roots.slice(0, rootLimit);
  if (
    requiredRoot !== undefined &&
    !selectedRoots.some(({ id }) => id === requiredRoot.id)
  ) {
    selectedRoots.splice(
      Math.max(0, selectedRoots.length - 1),
      1,
      requiredRoot,
    );
  }
  return selectedRoots.map((root) => {
    const group = visibleSessionGroup(hierarchy, root, expanded);
    return {
      ...group,
      children: boundedSessionRows(group.children, childLimit, selectedId),
    };
  });
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
    leftSession.stepStartedAt === rightSession.stepStartedAt &&
    leftSession.costBasis === rightSession.costBasis &&
    leftSession.costUsd === rightSession.costUsd &&
    leftSession.executionEnvironment === rightSession.executionEnvironment &&
    leftSession.id === rightSession.id &&
    leftSession.model === rightSession.model &&
    leftSession.parentExecutionGeneration ===
      rightSession.parentExecutionGeneration &&
    leftSession.parentSessionId === rightSession.parentSessionId &&
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

interface SessionListItemProps {
  readonly controller: SessionController;
  readonly expanded: Accessor<ReadonlySet<string>>;
  readonly onSelect?: (() => void) | undefined;
  readonly onToggleChildren: (sessionId: string) => void;
  readonly row: SessionListRow;
  readonly selectedId: Accessor<string | undefined>;
}

type SessionRowsProps = Omit<SessionListItemProps, "row"> & {
  readonly rows: readonly SessionListRow[];
  readonly trailing?: JSX.Element;
};

function SessionListItem(props: SessionListItemProps): JSX.Element {
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

function SessionRows(props: SessionRowsProps): JSX.Element {
  return (
    <ul class="space-y-2">
      <For each={props.rows}>
        {(row) => (
          <SessionListItem
            controller={props.controller}
            expanded={props.expanded}
            onSelect={props.onSelect}
            onToggleChildren={props.onToggleChildren}
            row={row}
            selectedId={props.selectedId}
          />
        )}
      </For>
      {props.trailing}
    </ul>
  );
}

function EmptySessionList(): JSX.Element {
  return (
    <p class="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
      No sessions yet. Start one above to give an agent a task.
    </p>
  );
}

export function SessionList(props: {
  readonly controller: SessionController;
  readonly onSelect?: () => void;
}): JSX.Element {
  const state = createMemo(() => props.controller.view());
  const [visibleRootCount, setVisibleRootCount] =
    createSignal(SESSION_PAGE_SIZE);
  const [childLimits, setChildLimits] = createSignal<
    ReadonlyMap<string, number>
  >(new Map());
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const sessionSummaries = createMemo(() => state().sessions);
  const hierarchy = createMemo(() =>
    sessionHierarchy(sessionSummaries() ?? []),
  );
  const selectedId = createMemo(() => state().selectedId);
  const groups = createMemo(
    (previous: readonly SessionListGroup[] | undefined) => {
      const tree = hierarchy();
      const previousRows = previous?.flatMap(({ children, root }) => [
        root,
        ...children,
      ]);
      const current = boundedSessionGroups(
        tree,
        tree.roots,
        expanded(),
        visibleRootCount(),
        SESSION_PAGE_SIZE,
        selectedId(),
      ).map((group) => ({
        children: boundedSessionRows(
          visibleSessionGroup(tree, group.root.session, expanded()).children,
          childLimits().get(group.root.session.id) ?? SESSION_PAGE_SIZE,
          selectedId(),
        ),
        root: group.root,
      }));
      const retained = retainSessionListRows(
        previousRows,
        current.flatMap(({ children, root }) => [root, ...children]),
      );
      const byId = new Map(retained.map((row) => [row.session.id, row]));
      const next = current.map(({ children, root }) => ({
        children: children.map((row) => byId.get(row.session.id) ?? row),
        root: byId.get(root.session.id) ?? root,
      }));
      const previousByRoot = new Map(
        previous?.map((group) => [group.root.session.id, group]),
      );
      return next.map((group) => {
        const retained = previousByRoot.get(group.root.session.id);
        return retained?.root === group.root &&
          retained.children.length === group.children.length &&
          retained.children.every(
            (child, index) => child === group.children[index],
          )
          ? retained
          : group;
      });
    },
  );
  const hasMoreRoots = createMemo(
    () => visibleRootCount() < hierarchy().roots.length,
  );
  const rootRevision = createMemo(() =>
    hierarchy()
      .roots.map(({ id }) => id)
      .toSorted()
      .join("\n"),
  );
  const loadMoreRoots = (): void => {
    setVisibleRootCount((current) =>
      Math.min(hierarchy().roots.length, current + SESSION_PAGE_SIZE),
    );
  };
  const loadMoreChildren = (parentId: string): void => {
    setChildLimits((current) => {
      const next = new Map(current);
      next.set(
        parentId,
        (next.get(parentId) ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE,
      );
      return next;
    });
  };
  const loadMoreOnScroll: JSX.EventHandler<HTMLUListElement, Event> = (
    event,
  ) => {
    const list = event.currentTarget;
    if (
      hasMoreRoots() &&
      list.scrollHeight - list.clientHeight - list.scrollTop <=
        SESSION_SCROLL_LOAD_THRESHOLD
    ) {
      loadMoreRoots();
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
      setVisibleRootCount(SESSION_PAGE_SIZE);
      setChildLimits(new Map());
    }
    return currentRootRevision;
  });

  return (
    <Show
      fallback={<EmptySessionList />}
      when={(sessionSummaries()?.length ?? 0) > 0}
    >
      <ul
        class="session-list-items min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5"
        data-visible-root-count={visibleRootCount()}
        onScroll={loadMoreOnScroll}
      >
        <For each={groups()}>
          {(group) => (
            <li data-session-group={group.root.session.id}>
              <SessionRows
                {...props}
                expanded={expanded}
                onToggleChildren={toggleChildren}
                rows={[group.root]}
                selectedId={selectedId}
              />
              <Show when={group.children.length > 0}>
                <section
                  aria-label={`Child sessions for ${group.root.session.title}`}
                  class="mt-2"
                  data-child-session-group={group.root.session.id}
                >
                  <SessionRows
                    {...props}
                    expanded={expanded}
                    onToggleChildren={toggleChildren}
                    rows={group.children}
                    selectedId={selectedId}
                    trailing={
                      <Show
                        when={
                          group.children.length <
                          visibleSessionGroup(
                            hierarchy(),
                            group.root.session,
                            expanded(),
                          ).children.length
                        }
                      >
                        <li class="flex justify-center pt-1">
                          <button
                            class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200"
                            data-load-more-children={group.root.session.id}
                            onClick={() => {
                              loadMoreChildren(group.root.session.id);
                            }}
                            type="button"
                          >
                            Load more children
                          </button>
                        </li>
                      </Show>
                    }
                  />
                </section>
              </Show>
            </li>
          )}
        </For>
        <Show when={hasMoreRoots()}>
          <li class="flex justify-center pt-1">
            <button
              class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200"
              data-load-more-sessions="true"
              onClick={loadMoreRoots}
              type="button"
            >
              Load more
            </button>
          </li>
        </Show>
      </ul>
    </Show>
  );
}
