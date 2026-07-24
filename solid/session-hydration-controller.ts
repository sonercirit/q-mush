import { isRecord } from "../shared/auth-model.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";
import {
  sessionDataMatches,
  type SessionRealtimeState,
} from "./session-controller-state.ts";
import { sessionDetailState } from "./session-detail-state.ts";
import { mostRecentSessionDirectory } from "./session-state.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export class SessionHydrationController {
  #initialLoadPending = false;
  #rehydrating = false;
  #rehydratePending = false;
  readonly #realtime: SessionRealtimeState;
  readonly #sessionMutationPending: () => boolean;
  readonly #transport: SessionCommandTransport;
  readonly #view: RevisionState<SessionViewState>;

  constructor(
    view: RevisionState<SessionViewState>,
    realtime: SessionRealtimeState,
    transport: SessionCommandTransport,
    sessionMutationPending: () => boolean,
  ) {
    this.#realtime = realtime;
    this.#sessionMutationPending = sessionMutationPending;
    this.#transport = transport;
    this.#view = view;
  }

  get initialLoadPending(): boolean {
    return this.#initialLoadPending;
  }

  listenForReconnect(): void {
    this.#transport.onReconnect?.(() => {
      this.#rehydratePending = true;
      this.continueRehydrate();
    });
  }

  applyInitialSessions(
    sessions: readonly AgentSessionSummary[],
  ): string | undefined {
    this.#setInitialSessions(sessions);
    return sessions[0]?.id;
  }

  #setInitialSessions(sessions: readonly AgentSessionSummary[]): void {
    const selectedId = sessions[0]?.id;
    const workingDirectory = mostRecentSessionDirectory(sessions);
    this.#view.patch({
      draft: { ...this.#view.value.draft, workingDirectory },
      selectedId,
      sessions,
    });
  }

  async readSelectedDetail(
    sessionId: string | undefined,
    revision: number,
  ): Promise<void> {
    if (sessionId !== undefined) {
      await this.readDetail(sessionId, revision, true);
    }
  }

  async load(): Promise<void> {
    const revision = this.#view.begin({
      detail: undefined,
      error: undefined,
      loadingDetail: false,
      selectedId: undefined,
      sessions: undefined,
    });
    this.#initialLoadPending = true;
    try {
      await this.#applySubscription({
        apply: async (sessions) => {
          const selectedId = this.applyInitialSessions(sessions);
          await this.readSelectedDetail(selectedId, revision);
        },
        error: "We could not load your agent sessions. Please try again.",
        failurePatch: { sessions: [] },
        revision,
      });
    } finally {
      this.#initialLoadPending = false;
      this.continueRehydrate();
    }
  }

  reset(): void {
    this.#initialLoadPending = false;
    this.#rehydrating = false;
    this.#rehydratePending = false;
  }

  continueRehydrate(): void {
    if (
      !this.#rehydratePending ||
      this.#initialLoadPending ||
      this.#rehydrating ||
      this.#sessionMutationPending()
    ) {
      return;
    }
    this.#rehydratePending = false;
    this.#rehydrating = true;
    void this.#rehydrate().finally(() => {
      this.#rehydrating = false;
      this.continueRehydrate();
    });
  }

  async readDetail(
    sessionId: string,
    revision: number,
    showLoading: boolean,
  ): Promise<void> {
    if (showLoading) {
      this.#view.patch({ detail: undefined, loadingDetail: true });
    }

    try {
      const value = await this.#transport.command(
        SESSION_REALTIME_OPERATIONS.read,
        { sessionId },
      );
      if (!isRecord(value) || !("session" in value)) {
        throw new Error("The session detail acknowledgement was invalid");
      }
      const detail = readSessionDetail(value["session"]);

      if (this.#view.value.selectedId === sessionId) {
        const detailState = sessionDetailState(this.#view.value, detail, {
          loadingDetail: false,
        });

        if (
          !showLoading &&
          !this.#view.value.loadingDetail &&
          sessionDataMatches(this.#view.value.detail, detail) &&
          sessionDataMatches(this.#view.value.sessions, detailState.sessions)
        ) {
          return;
        }

        this.#view.patchCurrent(revision, detailState);
        this.#realtime.applyDetail(detail);
      }
    } catch {
      if (showLoading) {
        this.#view.patchCurrent(revision, {
          error: "We could not load that session transcript.",
          loadingDetail: false,
        });
      }
    }
  }

  async #subscribe(): Promise<readonly AgentSessionSummary[]> {
    return readSessionList(
      await this.#transport.command(SESSION_REALTIME_OPERATIONS.subscribe, {}),
    );
  }

  async #applySubscription(options: {
    readonly apply: (
      sessions: readonly AgentSessionSummary[],
    ) => Promise<void> | void;
    readonly error: string;
    readonly failurePatch: Partial<SessionViewState>;
    readonly revision: number;
  }): Promise<void> {
    try {
      const sessions = await this.#subscribe();
      if (this.#view.isCurrent(options.revision)) {
        await options.apply(sessions);
      }
    } catch {
      this.#view.patchCurrent(options.revision, {
        error: options.error,
        ...options.failurePatch,
      });
    }
  }

  async #rehydrate(): Promise<void> {
    const revision = this.#view.begin({ loadingDetail: true });
    await this.#applySubscription({
      apply: async (sessions) => {
        this.#realtime.applySessions(sessions);
        const selectedId = this.#view.value.selectedId;
        if (selectedId === undefined) {
          this.#view.patchCurrent(revision, {
            detail: undefined,
            loadingDetail: false,
          });
          return;
        }
        await this.readSelectedDetail(selectedId, revision);
      },
      error: "The realtime connection could not restore this session.",
      failurePatch: { loadingDetail: false },
      revision,
    });
  }
}
