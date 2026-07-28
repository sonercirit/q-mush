import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SESSION_PROVIDER_CACHE_WARNING } from "../shared/session-provider-update.ts";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import { OpenRouterProviderSelect } from "./session-provider-select.tsx";
import {
  providerCredentialValue,
  sessionProviderUpdateDraft,
  type SessionProviderUpdateCredential,
  type SessionProviderUpdateDraft,
  type SessionProviderUpdateView,
} from "./session-provider-update-model.ts";

function credentialOptions(
  credentials: readonly SessionProviderUpdateCredential[],
): readonly CustomSelectOption[] {
  return credentials.map((credential) => ({
    label: `${credential.provider === "openai" ? "OpenAI" : "OpenRouter"} · ${credential.label}`,
    value: providerCredentialValue({
      credentialId: credential.id,
      provider: credential.provider,
    }),
  }));
}

function modelOptions(
  catalog: AgentModelCatalog | undefined,
): readonly CustomSelectOption[] {
  return catalog?.models.map(({ id, label }) => ({ label, value: id })) ?? [];
}

export function SessionProviderUpdateEditor(
  props: SessionProviderUpdateView & {
    readonly detail: AgentSessionDetail;
    readonly disabled: boolean;
  },
): JSX.Element {
  const parseCredential = (
    value: string,
  ):
    | Pick<SessionProviderUpdateDraft, "credentialId" | "provider">
    | undefined => {
    const [provider, ...identityParts] = value.split(":");
    const credentialId = identityParts.join(":");
    if (credentialId.length === 0) return undefined;
    switch (provider) {
      case "openai":
      case "openrouter":
        return { credentialId, provider };
      case undefined:
      default:
        return undefined;
    }
  };
  const [draft, setDraft] = createSignal(
    sessionProviderUpdateDraft(props.detail),
  );
  const [models, setModels] = createSignal<AgentModelCatalog>();
  const [providers, setProviders] =
    createSignal<Awaited<ReturnType<typeof props.onDiscoverProviders>>>();
  const [open, setOpen] = createSignal<"credential" | "model" | "provider">();
  const [expanded, setExpanded] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let discovery = 0;

  const discoverModels = async (
    next: SessionProviderUpdateDraft,
  ): Promise<void> => {
    const current = (discovery += 1);
    setModels(undefined);
    setProviders(undefined);
    const catalog = await props.onDiscoverModels(
      next.provider,
      next.credentialId,
    );
    if (current !== discovery) return;
    setModels(catalog);
    if (catalog === undefined) {
      setError("Models are unavailable for that credential.");
      return;
    }
    const model = catalog.models.some(({ id }) => id === next.model)
      ? next.model
      : (catalog.models[0]?.id ?? "");
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
    <section class="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h4 class="text-sm font-semibold text-slate-200">
        <span>Session provider</span>
        <button
          aria-expanded={expanded()}
          class="ml-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          data-session-provider-toggle="true"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded() ? "Collapse" : "Expand"}
        </button>
      </h4>
      <Show when={expanded()}>
        <p class="mt-1 text-xs leading-5 text-slate-500">
          Change the model account, provider, model, or OpenRouter serving
          provider for future turns.
        </p>
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
            options={credentialOptions(props.credentials)}
            required
            selectedValue={providerCredentialValue(draft())}
          />
          <CustomSelect
            disabled={
              props.disabled || pending() || modelOptions(models()).length === 0
            }
            emptyLabel="Models unavailable"
            id="session-provider-model"
            label="Model"
            name="sessionProviderModel"
            onChoose={chooseModel}
            onToggle={() => setOpen(open() === "model" ? undefined : "model")}
            open={open() === "model"}
            options={modelOptions(models())}
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
        <Show when={error()}>
          {(message) => (
            <p class="mt-4 text-sm text-rose-200" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <button
          class="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          data-session-provider-update-submit="true"
          disabled={disabled()}
          onClick={() => setConfirming(true)}
          type="button"
        >
          Change provider
        </button>
      </Show>
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
    </section>
  );
}
