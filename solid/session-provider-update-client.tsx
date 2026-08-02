import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SESSION_PROVIDER_CACHE_WARNING } from "../shared/session-provider-update.ts";
import { CustomSelect } from "./custom-select.tsx";
import {
  createSessionEditorRequestState,
  SessionEditorError,
  SessionEditorSection,
} from "./session-editor-client.tsx";
import {
  modelCatalogOptions,
  modelCredentialOptions,
  parseModelCredentialValue,
} from "./session-model-options.ts";
import { OpenRouterProviderSelect } from "./session-provider-select.tsx";
import {
  providerCredentialValue,
  sessionProviderUpdateDraft,
  type SessionProviderUpdateDraft,
  type SessionProviderUpdateView,
} from "./session-provider-update-model.ts";

export function SessionProviderUpdateEditor(
  props: SessionProviderUpdateView & {
    readonly detail: AgentSessionDetail;
    readonly disabled: boolean;
  },
): JSX.Element {
  const parseCredential = parseModelCredentialValue;
  const [draft, setDraft] = createSignal(
    sessionProviderUpdateDraft(untrack(() => props.detail)),
  );
  const [models, setModels] = createSignal<AgentModelCatalog>();
  const [providers, setProviders] =
    createSignal<Awaited<ReturnType<typeof props.onDiscoverProviders>>>();
  const [open, setOpen] = createSignal<"credential" | "model" | "provider">();
  const [confirming, setConfirming] = createSignal(false);
  const request = createSessionEditorRequestState();
  const { error, latest: discovery, pending, setError, setPending } = request;
  let discoveredSelection: SessionProviderUpdateDraft | undefined;

  const discoverModels = async (
    next: SessionProviderUpdateDraft,
  ): Promise<void> => {
    const current = discovery.begin();
    setModels(undefined);
    setProviders(undefined);
    const result = await props.onDiscoverModels(
      next.provider,
      next.credentialId,
    );
    if (!discovery.isLatest(current)) return;
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setModels(result);
    const model = result.models.some(({ id }) => id === next.model)
      ? next.model
      : (result.models[0]?.id ?? "");
    const selected = {
      ...next,
      model,
      openRouterProviderTag:
        model === next.model ? next.openRouterProviderTag : null,
    };
    setDraft(selected);
    if (selected.provider === "openrouter" && model.length > 0) {
      setProviders(
        await props.onDiscoverProviders(selected.credentialId, model),
      );
    }
  };

  createEffect(() => {
    const initial = sessionProviderUpdateDraft(props.detail);
    if (
      initial.credentialId === discoveredSelection?.credentialId &&
      initial.model === discoveredSelection.model &&
      initial.provider === discoveredSelection.provider
    ) {
      return;
    }
    discoveredSelection = initial;
    setDraft(initial);
    setModels(undefined);
    setProviders(undefined);
    setConfirming(false);
    setError(undefined);
    void discoverModels(initial);
  });

  const chooseCredential = (value: string): void => {
    const credential = parseCredential(value);
    if (credential === undefined) return;
    if (
      credential.credentialId === draft().credentialId &&
      credential.provider === draft().provider
    ) {
      setOpen(undefined);
      return;
    }
    setError(undefined);
    setOpen(undefined);
    void discoverModels({
      ...draft(),
      ...credential,
      model: "",
      openRouterProviderTag: null,
    });
  };
  const chooseModel = (model: string): void => {
    if (model === draft().model) {
      setOpen(undefined);
      return;
    }
    const next = { ...draft(), model, openRouterProviderTag: null };
    setDraft(next);
    setOpen(undefined);
    setProviders(undefined);
    if (next.provider === "openrouter") {
      void props
        .onDiscoverProviders(next.credentialId, model)
        .then(setProviders);
    }
  };
  const apply = async (): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      if (await props.onApply(draft())) setConfirming(false);
    } catch {
      setError("We could not change the session provider. Please try again.");
    } finally {
      setPending(false);
    }
  };
  const disabled = () =>
    props.disabled || pending() || draft().model.length === 0;

  return (
    <>
      <SessionEditorSection
        description={
          <>
            Change the model account, provider, model, or OpenRouter serving
            provider for future turns.
          </>
        }
        kind="provider"
        title="Session provider"
      >
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <CustomSelect
            disabled={
              props.disabled || pending() || props.credentials.length === 0
            }
            emptyLabel="No scoped model credentials"
            id="session-provider-credential"
            label="Model credential"
            name="sessionProviderCredential"
            onChoose={chooseCredential}
            onToggle={() =>
              setOpen(open() === "credential" ? undefined : "credential")
            }
            open={open() === "credential"}
            options={modelCredentialOptions(
              props.credentials.map(({ id, label, provider }) => ({
                credentialId: id,
                label,
                provider,
              })),
            )}
            required
            selectedValue={providerCredentialValue(draft())}
          />
          <CustomSelect
            disabled={
              props.disabled ||
              pending() ||
              modelCatalogOptions(models()).length === 0
            }
            emptyLabel="Models unavailable"
            id="session-provider-model"
            label="Model"
            name="sessionProviderModel"
            onChoose={chooseModel}
            onToggle={() => setOpen(open() === "model" ? undefined : "model")}
            open={open() === "model"}
            options={modelCatalogOptions(models())}
            required
            selectedValue={draft().model}
          />
          <Show
            when={draft().provider === "openrouter" && draft().model.length > 0}
          >
            <OpenRouterProviderSelect
              controller={{
                chooseOption: (_name, value) => {
                  setDraft({
                    ...draft(),
                    openRouterProviderTag: value || null,
                  });
                  setOpen(undefined);
                },
                retryProviders: () => {
                  void props
                    .onDiscoverProviders(draft().credentialId, draft().model)
                    .then(setProviders);
                },
                toggleSelect: () =>
                  setOpen(open() === "provider" ? undefined : "provider"),
              }}
              creating={props.disabled || pending()}
              discovery={{
                catalog: providers(),
                error: providers() === undefined ? "unavailable" : undefined,
                key: "provider-update",
                loading: providers() === undefined,
              }}
              open={open() === "provider"}
              selectedValue={draft().openRouterProviderTag ?? ""}
            />
          </Show>
        </div>
        <SessionEditorError message={error()} />
        <button
          class="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          data-session-provider-update-submit="true"
          disabled={disabled()}
          onClick={() => setConfirming(true)}
          type="button"
        >
          Change provider
        </button>
      </SessionEditorSection>
      <Show when={confirming()}>
        <div
          aria-modal="true"
          class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
          role="dialog"
        >
          <div class="w-full max-w-lg rounded-3xl border border-amber-300/25 bg-slate-900 p-6 shadow-2xl">
            <h3 class="text-xl font-semibold text-white">
              Change session provider?
            </h3>
            <p class="mt-4 text-sm leading-6 text-amber-100">
              {SESSION_PROVIDER_CACHE_WARNING}
            </p>
            <div class="mt-6 flex justify-end gap-3">
              <For each={["Cancel", "Change provider"]}>
                {(label) => (
                  <button
                    class={
                      label === "Cancel"
                        ? "rounded-xl border border-white/10 px-4 py-2 text-slate-200"
                        : "rounded-xl bg-amber-200 px-4 py-2 font-semibold text-slate-950"
                    }
                    data-session-provider-update-confirm={
                      label === "Cancel" ? undefined : "true"
                    }
                    disabled={pending()}
                    onClick={() =>
                      label === "Cancel" ? setConfirming(false) : void apply()
                    }
                    type="button"
                  >
                    {pending() && label !== "Cancel" ? "Changing…" : label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
