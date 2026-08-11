import { createSignal, Show, type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import type {
  ProviderQuotaResetOutcome,
  ProviderQuotaSnapshot,
} from "../shared/provider-quota.ts";
import type { ProviderPanelController } from "./provider-client.tsx";
import type { ProviderCredential } from "./provider-credential-model.ts";

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

export function readProviderQuota(value: unknown): ProviderQuotaSnapshot {
  if (!isRecord(value)) {
    throw new Error("The server returned invalid provider quota data");
  }
  const threshold = value["autoResetThresholdPercent"];
  const banked = nullableNumber(value["bankedResetCount"]);
  const exhaustion = nullableNumber(value["estimatedExhaustionAt"]);
  const remaining = nullableNumber(value["remainingPercent"]);
  const resetsAt = nullableNumber(value["resetsAt"]);
  const resetSupported = value["resetSupported"];
  const source = value["source"];
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    banked === undefined ||
    exhaustion === undefined ||
    remaining === undefined ||
    resetsAt === undefined ||
    typeof resetSupported !== "boolean" ||
    typeof source !== "string"
  ) {
    throw new Error("The server returned invalid provider quota data");
  }
  return {
    autoResetThresholdPercent: threshold,
    bankedResetCount: banked,
    estimatedExhaustionAt: exhaustion,
    remainingPercent: remaining,
    resetSupported,
    resetsAt,
    source,
  };
}

export function readQuotaResetResult(value: unknown): {
  readonly outcome: ProviderQuotaResetOutcome;
  readonly quota: ProviderQuotaSnapshot;
} {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid quota reset result");
  }
  const outcome = value["outcome"];
  if (
    outcome !== "already_redeemed" &&
    outcome !== "no_credit" &&
    outcome !== "nothing_to_reset" &&
    outcome !== "reset"
  ) {
    throw new Error("The server returned an invalid quota reset result");
  }
  return { outcome, quota: readProviderQuota(value["quota"]) };
}

function durationLabel(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "now";
  }
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = Math.ceil(minutes / 60);
  return hours < 48
    ? `${String(hours)} hr`
    : `${String(Math.ceil(hours / 24))} days`;
}

function timeValue(value: number | null, unavailable: string): string {
  return value === null
    ? unavailable
    : `${new Date(value).toLocaleString()} (${durationLabel(value - Date.now())} remaining)`;
}

function remainingLabel(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(1)}%`;
}

function quotaTimeField(
  label: string,
  value: number | null,
  unavailable: string,
): JSX.Element {
  return (
    <div>
      <dt class="text-xs text-slate-500">{label}</dt>
      <dd>{timeValue(value, unavailable)}</dd>
    </div>
  );
}

function resetOutcomeNotice(outcome: ProviderQuotaResetOutcome): string {
  switch (outcome) {
    case "already_redeemed":
      return "That reset request was already applied; no second reset was spent.";
    case "no_credit":
      return "No banked reset is available.";
    case "nothing_to_reset":
      return "The provider reports that no quota window can be reset.";
    case "reset":
      return "One banked reset was consumed and eligible quota windows were reset.";
  }
}

export function ProviderQuota(props: {
  readonly controller: ProviderPanelController;
  readonly credential: ProviderCredential;
}): JSX.Element {
  const state = (): ReturnType<ProviderPanelController["view"]> =>
    props.controller.view();
  const [confirming, setConfirming] = createSignal(false);
  const quota = () => state().quotas[props.credential.id];
  const pending = () => state().quotaPendingId === props.credential.id;
  const thresholdPending = () =>
    state().quotaThresholdPendingId === props.credential.id;
  return (
    <div class="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-3 text-sm text-slate-300 md:col-span-full">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="font-semibold text-slate-100">Quota</p>
        <button
          class="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-white/20 disabled:cursor-wait disabled:opacity-50"
          disabled={state().quotaLoadingIds.includes(props.credential.id)}
          onClick={() => {
            void props.controller.loadQuota(props.credential.id);
          }}
          type="button"
        >
          Refresh quota
        </button>
      </div>
      <Show
        fallback={<p class="mt-3 text-slate-500">Loading quota…</p>}
        when={quota()}
      >
        {(current) => (
          <>
            <dl class="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-slate-500">Remaining</dt>
                <dd>{remainingLabel(current().remainingPercent)}</dd>
              </div>
              {quotaTimeField(
                "Estimated exhaustion",
                current().estimatedExhaustionAt,
                "Unavailable from provider data",
              )}
              {quotaTimeField(
                "Provider reset",
                current().resetsAt,
                "Unavailable from provider",
              )}
              <div>
                <dt class="text-xs text-slate-500">Banked resets</dt>
                <dd>
                  {current().bankedResetCount === null
                    ? "Not offered by this account flow"
                    : String(current().bankedResetCount)}
                </dd>
              </div>
            </dl>
            <p class="mt-2 text-xs text-slate-500">
              {`Source: ${current().source}`}
            </p>
            <form
              class="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get(
                  "threshold",
                );
                if (typeof value === "string") {
                  void props.controller.setQuotaThreshold(
                    props.credential.id,
                    Number(value),
                  );
                }
              }}
            >
              <label class="text-xs text-slate-400">
                Auto-use banked reset at remaining quota (%)
                <input
                  class="mt-1 block min-h-10 w-28 rounded-lg border border-white/10 bg-slate-950 px-3 text-white"
                  disabled={thresholdPending() || !current().resetSupported}
                  max="100"
                  min="0"
                  name="threshold"
                  step="0.1"
                  type="number"
                  value={current().autoResetThresholdPercent}
                />
              </label>
              <button
                class="min-h-10 rounded-lg border border-cyan-300/20 px-3 text-xs font-semibold text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={thresholdPending() || !current().resetSupported}
                type="submit"
              >
                {thresholdPending() ? "Saving…" : "Save threshold"}
              </button>
            </form>
            <Show when={current().resetSupported}>
              <div class="mt-3">
                <Show
                  fallback={
                    <button
                      class="min-h-10 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 text-xs font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={pending() || current().bankedResetCount === 0}
                      onClick={() => setConfirming(true)}
                      type="button"
                    >
                      Consume one banked reset
                    </button>
                  }
                  when={confirming()}
                >
                  <div class="rounded-lg border border-amber-300/25 bg-amber-300/10 p-3">
                    <p class="text-amber-100">
                      This changes your OpenAI account and spends one banked
                      reset. Continue?
                    </p>
                    <div class="mt-2 flex gap-2">
                      <button
                        class="min-h-10 rounded-lg bg-amber-200 px-3 text-xs font-semibold text-slate-950 disabled:cursor-wait disabled:opacity-60"
                        disabled={pending()}
                        onClick={() => {
                          void props.controller
                            .consumeQuotaReset(props.credential.id)
                            .then((outcome) => {
                              if (outcome !== undefined) {
                                setConfirming(false);
                              }
                            });
                        }}
                        type="button"
                      >
                        {pending() ? "Consuming…" : "Confirm reset"}
                      </button>
                      <button
                        class="min-h-10 rounded-lg border border-white/10 px-3 text-xs"
                        disabled={pending()}
                        onClick={() => setConfirming(false)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
            <Show
              when={state().quotaNotice?.credentialId === props.credential.id}
            >
              <p class="mt-3 text-xs text-emerald-200" role="status">
                {resetOutcomeNotice(state().quotaNotice?.outcome ?? "reset")}
              </p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
