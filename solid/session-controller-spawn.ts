import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import type { SessionCreationDescriptor } from "./session-controller-create.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export interface UserSpawnSessionSelection extends Omit<
  SessionCreationDescriptor,
  "images" | "openRouterProviderTag" | "reasoningEffort"
> {
  readonly parentGeneration: number;
  readonly parentSessionId: string;
  readonly reasoningEffort?: string;
}

export async function spawnSessionFromView(options: {
  readonly selection: UserSpawnSessionSelection;
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}): Promise<void> {
  const detail = options.view.value.detail;
  if (
    options.transport === undefined ||
    detail?.id !== options.selection.parentSessionId ||
    detail.generation !== options.selection.parentGeneration
  ) {
    throw new Error("The child session configuration is no longer valid");
  }
  const payload: Readonly<Record<string, unknown>> = {
    ...options.selection,
  };
  const spawned = readSessionDetail(
    await options.transport.command(SESSION_REALTIME_OPERATIONS.spawn, payload),
  );
  options.view.patch(
    sessionDetailState(options.view.value, spawned, {
      selectedId: spawned.id,
    }),
  );
}
