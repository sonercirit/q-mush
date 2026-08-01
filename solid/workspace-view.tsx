import { Show, type JSX } from "solid-js";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { PromptBank } from "./prompt-client.tsx";
import type { PromptController } from "./prompt-controller.ts";
import {
  BRAVE_SEARCH_PANEL,
  GENERIC_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
  ProviderPanel,
} from "./provider-client.tsx";
import type { ProviderController } from "./provider-controller.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { RunnerPanel } from "./runner-client.tsx";
import type { RunnerController } from "./runner-controller.ts";
import { AttachmentFallbackSettings } from "./session-attachment-fallbacks.tsx";
import { SessionPanel } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { credentialOptions } from "./session-credential-list.ts";
import { discoverProviderUpdateModels } from "./session-provider-update-controller.ts";
import { WorkspacePanel, WorkspaceSwitcher } from "./workspace-client.tsx";
import type { WorkspaceController } from "./workspace-controller.ts";

function Avatar(props: { readonly user: AuthenticatedUser }): JSX.Element {
  return (
    <Show
      fallback={
        <img
          alt=""
          class="size-12 rounded-2xl bg-slate-800 object-cover ring-1 ring-white/10"
          referrerPolicy="no-referrer"
          src={props.user.picture}
        />
      }
      when={props.user.picture === undefined}
    >
      <span
        aria-hidden="true"
        class="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-lg font-bold text-slate-950"
      >
        {props.user.name.charAt(0).toUpperCase()}
      </span>
    </Show>
  );
}

export function Workspace(props: {
  readonly agentSessions: SessionController;
  readonly braveSearch: ProviderController;
  readonly generic: ProviderController;
  readonly logout: () => Promise<void>;
  readonly logoutPending: boolean;
  readonly openAi: ProviderController;
  readonly openRouter: ProviderController;
  readonly prompts: PromptController;
  readonly runners: RunnerController;
  readonly user: AuthenticatedUser;
  readonly workspaces: WorkspaceController;
}): JSX.Element {
  const selectedWorkspaceId = (): string => props.workspaces.selectedIdView();
  const providerPanel = (
    configuration: typeof OPENAI_PANEL,
    controller: ProviderController,
  ): JSX.Element => (
    <ProviderPanel
      configuration={configuration}
      controller={controller}
      selectedWorkspaceId={selectedWorkspaceId()}
      workspaces={() => props.workspaces.view().workspaces}
    />
  );
  return (
    <div
      class="mt-8 min-w-0 space-y-5 sm:mt-10 sm:space-y-6 lg:mt-12"
      {...renderDebugBoundary("workspace", "Authenticated workspace")}
    >
      <WorkspaceSwitcher controller={props.workspaces} />
      <Show
        fallback={
          <section class="rounded-3xl border border-cyan-300/15 bg-cyan-300/[0.06] p-6 text-slate-300 sm:p-8">
            <h2 class="text-2xl font-semibold text-white">
              Global connections
            </h2>
            <p class="mt-3 max-w-2xl leading-7 text-slate-400">
              Global is a virtual scope for connections available to every
              workspace. Select an ordinary workspace to view or start sessions.
            </p>
          </section>
        }
        when={selectedWorkspaceId() !== GLOBAL_WORKSPACE_ID}
      >
        <SessionPanel
          controller={props.agentSessions}
          generic={props.generic.view}
          openAi={props.openAi.view}
          openRouter={props.openRouter.view}
          runners={props.runners.view}
        />
      </Show>
      <AttachmentFallbackSettings
        credentials={credentialOptions(
          props.openAi.view(),
          props.openRouter.view(),
          props.generic.view(),
        ).filter(({ credential }) => credential.isGlobal === true)}
        onDiscoverModels={(provider, credentialId) =>
          discoverProviderUpdateModels(
            props.agentSessions.transport,
            provider,
            credentialId,
          )
        }
      />
      <WorkspacePanel controller={props.workspaces} />
      <PromptBank
        controller={props.prompts}
        onInsert={(body, replace) =>
          props.agentSessions.insertPrompt(body, replace)
        }
      />
      <RunnerPanel
        controller={props.runners}
        workspaces={() => props.workspaces.view().workspaces}
      />
      <aside
        aria-label="Google account"
        class="flex min-w-0 flex-col gap-5 rounded-3xl border border-white/10 bg-slate-900/80 p-4 sm:p-6 md:flex-row md:items-center md:justify-between lg:p-8"
        {...renderDebugBoundary("google-account", "Google account")}
      >
        <div class="flex min-w-0 items-center gap-4">
          <Avatar user={props.user} />
          <div class="min-w-0">
            <p class="break-words font-semibold text-white">
              {props.user.name}
            </p>
            <p class="break-all text-sm text-slate-400">{props.user.email}</p>
          </div>
        </div>
        <button
          class="rounded-2xl border border-white/10 px-5 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          disabled={props.logoutPending}
          onClick={() => {
            void props.logout();
          }}
          type="button"
        >
          {props.logoutPending ? "Signing out…" : "Sign out"}
        </button>
      </aside>
      {providerPanel(OPENAI_PANEL, props.openAi)}
      {providerPanel(OPENROUTER_PANEL, props.openRouter)}
      {providerPanel(GENERIC_PANEL, props.generic)}
      {providerPanel(BRAVE_SEARCH_PANEL, props.braveSearch)}
    </div>
  );
}
