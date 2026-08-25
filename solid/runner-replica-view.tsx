import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import { isSha256Digest } from "../shared/digest.ts";
import { parseSerializedArray } from "../shared/serialized-array.ts";
import { requestJson } from "./browser-http.ts";
import { queryHostForDocument } from "./query-host.ts";

function replicaImageDigests(value: unknown): readonly string[] {
  const digests: string[] = [];
  for (const item of parseSerializedArray(value)) {
    if (isRecord(item) && isSha256Digest(item["digest"])) {
      digests.push(item["digest"]);
    }
  }
  return digests;
}

export function RunnerReplicaView(): JSX.Element {
  const host = queryHostForDocument(document);
  const emptyRecords: readonly Record<string, unknown>[] = [];
  const [views, setViews] = createSignal({
    messages: emptyRecords,
    sessions: emptyRecords,
  });
  const [selected, setSelected] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  const [viewComplete, setViewComplete] = createSignal(false);
  const [replicaComplete, setReplicaComplete] = createSignal(false);
  const [retry, setRetry] = createSignal<{
    elapsedMilliseconds: number;
    previousRevision: string;
    restartCount: number;
    revision: string;
  }>();
  const [paired, setPaired] = createSignal(false);
  const [pairingCode, setPairingCode] = createSignal("");
  const load = (
    entity: "agent_messages" | "agent_sessions",
    apply: (records: readonly Record<string, unknown>[]) => void,
    sessionId?: string,
  ): void => {
    void host
      .read(entity, {
        limit: 100,
        ...(sessionId !== undefined && { sessionId }),
      })
      .then((view) => {
        setViewComplete(view.complete);
        apply(view.records);
      })
      .catch(() => setFailed(true));
  };
  const loadSessions = (): void => {
    load("agent_sessions", (sessions) =>
      setViews((value) => ({ ...value, sessions })),
    );
  };
  const loadStatus = async (signal?: AbortSignal): Promise<boolean> => {
    const response = await fetch("/api/local/status", {
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return false;
    const status: unknown = await response.json();
    if (signal?.aborted === true) return false;
    setReplicaComplete(isRecord(status) && status["complete"] === true);
    const progress = isRecord(status) ? status["retry"] : undefined;
    setRetry(
      isRecord(progress) &&
        typeof progress["elapsedMilliseconds"] === "number" &&
        typeof progress["previousRevision"] === "string" &&
        typeof progress["restartCount"] === "number" &&
        typeof progress["revision"] === "string"
        ? {
            elapsedMilliseconds: progress["elapsedMilliseconds"],
            previousRevision: progress["previousRevision"],
            restartCount: progress["restartCount"],
            revision: progress["revision"],
          }
        : undefined,
    );
    setPaired(true);
    return true;
  };
  onMount(() => {
    let disposed = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = (): void => {
      controller = new AbortController();
      void loadStatus(controller.signal)
        .then((authorized) => {
          if (authorized && !disposed) loadSessions();
        })
        .catch(() => undefined)
        .finally(() => {
          controller = undefined;
          if (!disposed) refresh = setTimeout(poll, 1_000);
        });
    };
    poll();
    onCleanup(() => {
      disposed = true;
      if (refresh !== undefined) clearTimeout(refresh);
      controller?.abort();
    });
  });
  const pair = async (): Promise<void> => {
    const challenge: unknown = await requestJson("/api/local/pair");
    if (!isRecord(challenge) || typeof challenge["transcript"] !== "string")
      throw new Error("The runner pairing challenge is invalid");
    const response = await fetch("/api/local/pair", {
      headers: {
        "x-q-mush-pairing-code": pairingCode(),
        "x-q-mush-pairing-transcript": challenge["transcript"],
      },
      method: "POST",
    });
    if (!response.ok) throw new Error("Pairing rejected");
    setPaired(true);
    await loadStatus();
    loadSessions();
  };
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
        <p class="font-semibold">
          Runner replica ·{" "}
          {replicaComplete() ? "Complete source" : "Joining copy"}
        </p>
        <p class="mt-1 text-sm">
          {viewComplete() ? "Complete active view" : "Partial active view"} ·
          Read only
        </p>
        <Show when={retry()}>
          {(progress) => (
            <p class="mt-2 text-sm" role="status">
              Retry {progress().restartCount}: {progress().previousRevision} →{" "}
              {progress().revision} after {progress().elapsedMilliseconds}ms
            </p>
          )}
        </Show>
        <p class="mt-2 text-sm">
          Mutations are disabled because this page is reading a bounded{" "}
          {host.origin} active view.
        </p>
      </div>
      <Show
        when={paired()}
        fallback={
          <form
            class="rounded-xl border border-white/10 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void pair().catch(() => setFailed(true));
            }}
          >
            <label for="runner-pairing-code">
              Runner terminal pairing code
            </label>
            <input
              id="runner-pairing-code"
              class="mt-2 block rounded bg-slate-950 p-2"
              onInput={(event) => setPairingCode(event.currentTarget.value)}
              required
            />
            <button
              class="mt-2 rounded bg-cyan-300 px-4 py-2 text-slate-950"
              type="submit"
            >
              Pair this browser
            </button>
          </form>
        }
      >
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
      </Show>
    </section>
  );
}
