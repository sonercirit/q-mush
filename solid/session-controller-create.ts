import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { SESSIONS_PATH } from "../shared/routes.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { requestJson } from "./browser-http.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import type {
  SessionCommandViewOptions,
  SessionCreationViewOptions,
} from "./session-controller-options.ts";
import { selectedSessionCredential } from "./session-controller-state.ts";
import { reconcileUnknownSessionMutation } from "./session-mutation-reconciliation.ts";
import { sessionMutationError } from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";

interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export type SessionCreationDescriptor = Readonly<{
  autoCompact: boolean;
  agentFilePath: string;
  credentialId: string;
  images: readonly AgentImage[];
  executionEnvironment: SessionViewState["draft"]["executionEnvironment"];
  model: string;
  openRouterProviderTag: string;
  prompt: string;
  provider: ProviderId;
  reasoningEffort: string;
  runnerId: string;
  tools: readonly AgentSessionToolName[];
  workingDirectory: string;
}>;

function sessionCreationDescriptor(
  draft: SessionViewState["draft"],
  credential: SessionCredentialSelection,
): SessionCreationDescriptor {
  return {
    ...credential,
    agentFilePath: draft.agentFilePath?.trim() ?? "",
    autoCompact: draft.autoCompact,
    executionEnvironment: draft.executionEnvironment,
    images: [...draft.images],
    model: draft.model.trim(),
    openRouterProviderTag: draft.openRouterProviderTag,
    prompt: draft.prompt.trim(),
    reasoningEffort: draft.reasoningEffort,
    runnerId: draft.runnerId,
    tools: [...draft.tools],
    workingDirectory: draft.workingDirectory.trim(),
  };
}

function sessionCreatePayload(
  descriptor: SessionCreationDescriptor,
): Readonly<Record<string, unknown>> {
  return {
    ...(descriptor.images.length === 0 ? {} : { images: descriptor.images }),
    ...(descriptor.agentFilePath.length === 0
      ? {}
      : { agentFilePath: descriptor.agentFilePath }),
    autoCompact: descriptor.autoCompact,
    credentialId: descriptor.credentialId,
    executionEnvironment: descriptor.executionEnvironment,
    provider: descriptor.provider,
    ...(descriptor.model.length === 0 ? {} : { model: descriptor.model }),
    ...(descriptor.openRouterProviderTag.length === 0
      ? {}
      : { openRouterProviderTag: descriptor.openRouterProviderTag }),
    prompt: descriptor.prompt,
    ...(descriptor.reasoningEffort.length === 0
      ? {}
      : { reasoningEffort: descriptor.reasoningEffort }),
    runnerId: descriptor.runnerId,
    tools: descriptor.tools,
    workingDirectory: descriptor.workingDirectory,
  };
}

export async function createSessionFromView(
  options: SessionCreationViewOptions,
): Promise<void> {
  if (
    options.view.value.creating ||
    sessionMutationPending(options.view.value)
  ) {
    return;
  }
  const credential = selectedSessionCredential(
    options.view.value.draft.credential,
  );
  const draft = options.view.value.draft;
  if (
    credential === undefined ||
    draft.runnerId.length === 0 ||
    draft.model.length === 0 ||
    (draft.prompt.trim().length === 0 && draft.images.length === 0) ||
    draft.workingDirectory.trim().length === 0
  ) {
    options.view.patch({
      error: "Choose a runner, credential, and model, then describe the task.",
    });
    return;
  }
  const sessions = options.view.value.sessions;
  if (sessions === undefined) {
    options.view.patch({
      error: "Wait for your agent sessions to finish loading, then try again.",
    });
    return;
  }
  const descriptor = sessionCreationDescriptor(draft, credential);
  const previousIds = new Set(sessions.map(({ id }) => id));
  const revision = options.view.begin({ creating: true, error: undefined });
  options.loader.noteMutationStarted();
  try {
    const detail = await createSession(descriptor, options.transport);
    options.view.patchCurrent(
      revision,
      sessionDetailState(options.view.value, detail, {
        creating: false,
        draft: { ...draft, images: [], prompt: "" },
        selectedId: detail.id,
      }),
    );
  } catch (error) {
    await reconcileUnknownSessionMutation({
      error,
      reconcile: (normalized) =>
        options.reconciliation.creation(
          revision,
          normalized,
          previousIds,
          descriptor,
        ),
      reject: (normalized) => {
        options.view.patchCurrent(revision, {
          creating: false,
          error: sessionMutationError(normalized, "start that session"),
        });
      },
    });
  } finally {
    options.loader.continueHydration();
  }
}

async function createSession(
  descriptor: SessionCreationDescriptor,
  transport?: SessionCommandViewOptions["transport"],
) {
  const payload = sessionCreatePayload(descriptor);
  const value =
    transport === undefined
      ? await requestJson(SESSIONS_PATH, {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      : await transport.command(SESSION_REALTIME_OPERATIONS.create, payload);
  return readSessionDetail(value);
}
