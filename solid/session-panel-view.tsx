import { createEffect, createSignal, type JSX } from "solid-js";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { RetryNotice } from "./collection.tsx";
import { DirectoryPicker } from "./directory-picker-client.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";
import {
  credentialFallbackReady,
  credentialOptions,
  defaultCredentialValue,
  defaultRunnerId,
  NewSessionForm,
  onlineRunners,
  type CredentialOption,
} from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { SessionResults } from "./session-focus-client.tsx";
import type { SessionPanelResources } from "./session-panel-resources.ts";
import {
  selectedSessionCredentialAvailable,
  selectedSessionRunnerAvailable,
} from "./session-resource-availability.ts";

export function SessionPanel(
  props: SessionPanelResources & { readonly controller: SessionController },
): JSX.Element {
  const state = props.controller.view;
  const online = (): readonly RunnerSummary[] => onlineRunners(props.runners());
  const credentials = (): readonly CredentialOption[] =>
    credentialOptions(props.openAi(), props.openRouter());
  const credentialsSettled = (): boolean =>
    credentialFallbackReady(props.openAi(), props.openRouter());
  const [focusMode, setFocusMode] = createSignal(false);
  const selectedRunner = (): RunnerSummary | undefined =>
    online().find(
      ({ id }) => id === props.controller.directoryPicker.state.runnerId,
    );

  const openDirectoryPicker = (): void => {
    setFocusMode(false);
    props.controller.openDirectoryPicker();
  };

  createEffect(() => {
    if (props.controller.directoryPicker.view().open) {
      setFocusMode(false);
    }
  });

  createEffect(() => {
    const runners = online();
    const options = credentials();
    props.controller.initializeDefaults(
      defaultRunnerId(runners),
      defaultCredentialValue(options),
      credentialsSettled(),
    );
  });

  return (
    <div
      data-credentials-settled={String(credentialsSettled())}
      data-session-panel="true"
    >
      <section
        aria-labelledby="agent-sessions-title"
        class={`rounded-3xl border border-emerald-300/15 bg-white/[0.06] p-4 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-6 lg:p-8 ${focusMode() ? "session-panel-focus" : ""}`}
        data-session-panel-focus={String(focusMode())}
        inert={props.controller.directoryPicker.view().open}
        {...renderDebugBoundary("sessions-panel", "Agent sessions panel")}
      >
        <p class="text-sm font-medium text-emerald-300">
          First-party agent runtime
        </p>
        <h2
          class="mt-2 text-2xl font-semibold text-white"
          id="agent-sessions-title"
        >
          New agent session
        </h2>
        <p class="mt-3 max-w-3xl leading-7 text-slate-400">
          Start and steer coding sessions on your connected computers. Q Mush
          owns the model loop and runner tools end to end.
        </p>
        <NewSessionForm
          controller={props.controller}
          credentials={credentials()}
          credentialsSettled={credentialsSettled()}
          onOpenDirectoryPicker={openDirectoryPicker}
          runners={online()}
          state={state()}
        />
        <RetryNotice
          error={state().error}
          onRetry={() => {
            void props.controller.load();
          }}
        />
        <SessionResults
          controller={props.controller}
          credentialAvailable={selectedSessionCredentialAvailable(
            state().detail,
            props.openAi(),
            props.openRouter(),
          )}
          focusMode={focusMode}
          runnerAvailable={selectedSessionRunnerAvailable(
            state().detail,
            props.runners(),
          )}
          setFocusMode={setFocusMode}
        />
      </section>
      <DirectoryPicker
        controller={props.controller.directoryPicker}
        onChoose={() => {
          props.controller.chooseDirectory();
        }}
        runnerName={selectedRunner()?.name ?? "Selected runner"}
      />
    </div>
  );
}
