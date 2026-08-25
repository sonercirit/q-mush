import { createSignal, For, onMount, Show, type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import { queryHostForLocation } from "./query-host.ts";

function replicaImageDigests(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) =>
      isRecord(item) &&
      typeof item["digest"] === "string" &&
      /^[a-f\d]{64}$/u.test(item["digest"])
        ? [item["digest"]]
        : [],
    );
  } catch {
    return [];
  }
}

export function RunnerReplicaView(): JSX.Element {
  const host = queryHostForLocation(window.location);
  const emptyRecords: readonly Record<string, unknown>[] = [];
  const [views, setViews] = createSignal({
    messages: emptyRecords,
    sessions: emptyRecords,
  });
  const [selected, setSelected] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  const load = (
    entity: "agent_messages" | "agent_sessions",
    apply: (records: readonly Record<string, unknown>[]) => void,
    sessionId?: string,
  ): void => {
    void host
      .read(entity, { limit: 100, ...(sessionId && { sessionId }) })
      .then((view) => {
        apply(view.records);
      })
      .catch(() => setFailed(true));
  };
  onMount(() => {
    load("agent_sessions", (sessions) =>
      setViews((value) => ({ ...value, sessions })),
    );
  });
  const select = (id: string): void => {
    setSelected(id);
    load(
      "agent_messages",
      (messages) => setViews((value) => ({ ...value, messages })),
      id,
    );
  };
  return (
    <section class="mt-8 grid gap-4" aria-label="Runner replica view">
      <div class="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 p-4 text-cyan-100">
        <p class="font-semibold">Runner replica · Complete copy</p>
        <p class="mt-1 text-sm">Partial active view · Read only</p>
        <p class="mt-2 text-sm">
          Mutations are disabled because this page is reading from the runner
          replica.
        </p>
      </div>
      <Show
        when={!failed()}
        fallback={<p role="alert">The runner replica is not ready.</p>}
      >
        <For each={views().sessions}>
          {(record) => {
            const id = String(record["id"]);
            const value = record["title"];
            return (
              <button
                class="rounded-xl border border-white/10 p-4 text-left"
                onClick={() => {
                  select(id);
                }}
                type="button"
              >
                {typeof value === "string" ? value : id}
              </button>
            );
          }}
        </For>
        <Show when={selected()}>
          <div class="rounded-xl border border-white/10 p-4">
            <For each={views().messages}>
              {(message) => {
                const content = message["content"];
                return (
                  <div>
                    <p class="whitespace-pre-wrap">
                      {typeof content === "string" ? content : ""}
                    </p>
                    <For each={replicaImageDigests(message["images"])}>
                      {(digest) => (
                        <img
                          alt="Session attachment"
                          class="mt-3 max-h-64 rounded-lg"
                          src={`/api/local/blob/${digest}`}
                        />
                      )}
                    </For>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <button
          class="cursor-not-allowed rounded-full border border-white/10 px-5 py-2 text-slate-500"
          disabled
          type="button"
        >
          New session unavailable in read-only replica
        </button>
      </Show>
    </section>
  );
}
