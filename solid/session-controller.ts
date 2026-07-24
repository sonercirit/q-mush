import { type Accessor } from "solid-js";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { DirectoryPickerController } from "./directory-picker-controller.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";
import {
  replaceSessionSummary,
  retainUnchangedSessionData,
  selectedSessionCredential,
  sessionDataMatches,
  SessionRealtimeState,
} from "./session-controller-state.ts";

import { selectedDraftOption } from "./session-form.ts";
import { appendAgentImageFiles } from "./session-image-input.ts";
import { SessionModelController } from "./session-model-controller.ts";
import {
  compactionModeMutation,
  compactSessionMutation,
  continueSessionMutation,
  executeSessionMutation,
  sessionMutationError,
  stopSessionMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import {
  initialSessionViewState,
  mostRecentSessionDirectory,
} from "./session-state.ts";
import {
  readSessionTranscriptFilters,
  writeSessionTranscriptFilters,
  type SessionTranscriptFilterName,
  type SessionTranscriptFilterStorage,
} from "./session-transcript-filters.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

const unreachableSessionTransport: SessionCommandTransport = {
  command: () => Promise.reject(new Error("connection_stopped")),
};

function detailMutationPending(state: SessionViewState): boolean {
  return state.compacting || state.sending || state.stopping;
}

function selectedDetailHasStatus(
  state: SessionViewState,
  allowed: (status: AgentSessionStatus) => boolean,
): boolean {
  return (
    state.selectedId !== undefined &&
    state.detail?.id === state.selectedId &&
    allowed(state.detail.status)
  );
}

function sessionIsActive(status: AgentSessionStatus): boolean {
  return status === "queued" || status === "running";
}

function sessionCanResume(status: AgentSessionStatus): boolean {
  return status === "idle" || status === "failed" || status === "stopped";
}

function browserTranscriptFilterStorage():
  SessionTranscriptFilterStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function selectedMutation(
  sessionId: string | undefined,
  create: (sessionId: string) => SessionMutation,
): SessionMutation | undefined {
  return sessionId === undefined ? undefined : create(sessionId);
}

export class SessionController {
  readonly #directoryPicker: DirectoryPickerController;
  readonly #models: SessionModelController;
  readonly #realtime: SessionRealtimeState;
  readonly #transcriptFilterStorage: SessionTranscriptFilterStorage | undefined;
  readonly #view: RevisionState<SessionViewState>;
  readonly #reactiveView: ReactiveState<SessionViewState>;
  #initialLoadPending = false;
  #rehydratePending = false;
  readonly #transport: SessionCommandTransport;

  constructor(
    reactiveView = createReactiveState(initialSessionViewState()),
    directoryPicker = new DirectoryPickerController(),
    transcriptFilterStorage:
      | SessionTranscriptFilterStorage
      | null
      | undefined = browserTranscriptFilterStorage(),
    transport: SessionCommandTransport = unreachableSessionTransport,
  ) {
    this.#reactiveView = reactiveView;
    this.#transport = transport;
    this.#view = new RevisionState(reactiveView.state, reactiveView.setState);
    const transcriptFilters =
      transcriptFilterStorage === null || transcriptFilterStorage === undefined
        ? reactiveView.state().transcriptFilters
        : readSessionTranscriptFilters(transcriptFilterStorage);
    this.#view.patch({ transcriptFilters });
    this.#realtime = new SessionRealtimeState(this.#view);
    this.#models = new SessionModelController(this.#view, transport);
    transport.onReconnect?.(() => {
      this.#rehydratePending = true;
      this.#continueRehydrate();
    });
    this.#directoryPicker = directoryPicker;
    this.#transcriptFilterStorage = transcriptFilterStorage ?? undefined;
  }

  applyDetail(detail: AgentSessionDetail): void {
    if (this.#view.value.creating || detailMutationPending(this.#view.value)) {
      return;
    }
    this.#realtime.applyDetail(detail);
  }

  applyDelta(event: Parameters<SessionRealtimeState["applyDelta"]>[0]): void {
    this.#realtime.applyDelta(event);
  }

  #applyInitialSessions(
    sessions: readonly AgentSessionSummary[],
  ): string | undefined {
    this.#patchDraft({
      workingDirectory: mostRecentSessionDirectory(sessions),
    });
    const selectedId = sessions[0]?.id;
    this.#view.patch({ selectedId, sessions });
    return selectedId;
  }

  async #readSelectedDetail(
    sessionId: string | undefined,
    revision: number,
  ): Promise<void> {
    if (sessionId !== undefined) {
      await this.#readDetail(sessionId, revision, true);
    }
  }

  applyRealtime(sessions: readonly AgentSessionSummary[]): void {
    const initial =
      this.#view.value.sessions === undefined && !this.#initialLoadPending;
    this.#realtime.applySessions(sessions);
    if (!initial) {
      return;
    }
    const selectedId = this.#applyInitialSessions(sessions);
    void this.#readSelectedDetail(selectedId, this.#view.begin());
  }

  get directoryPicker(): DirectoryPickerController {
    return this.#directoryPicker;
  }

  get state(): SessionViewState {
    return {
      ...this.#view.value,
      directoryPicker: this.#directoryPicker.state,
    };
  }

  get view(): Accessor<SessionViewState> {
    return this.#reactiveView.state;
  }

  addImages(files: readonly File[], follow: boolean): Promise<void> {
    return this.#addImages(files, follow);
  }

  chooseDirectory(): void {
    const workingDirectory = this.#directoryPicker.choose();

    if (workingDirectory !== undefined) {
      this.setDraftField("workingDirectory", workingDirectory);
    }
  }

  chooseOption(
    name: string,
    value: string,
    availableValues: readonly string[],
  ): void {
    const panel = this.#view.value;
    const draft = selectedDraftOption(panel, name, value, availableValues);

    if (draft === undefined) {
      return;
    }

    this.#view.patch({ draft, openSelect: undefined });

    if (name === "credential") {
      this.#models.ensure(value);
    }
  }

  compact(): Promise<void> {
    return this.#compact();
  }

  continueSession(): Promise<void> {
    return this.#continue();
  }

  create(): Promise<void> {
    return this.#create();
  }

  initializeDefaults(
    runnerId: string,
    credential: string,
    credentialSettled: boolean,
  ): void {
    const draft = this.#view.value.draft;
    const defaultedCredential = credentialSettled
      ? credential
      : draft.credential;
    const next = {
      ...draft,
      credential: defaultedCredential,
      ...(defaultedCredential === draft.credential
        ? {}
        : { model: "", reasoningEffort: "" }),
      runnerId,
    };

    if (
      next.credential !== draft.credential ||
      next.runnerId !== draft.runnerId
    ) {
      this.#view.patch({ draft: next });
    }

    if (next.credential.length > 0) {
      this.#models.ensure(next.credential);
    }
  }

  openDirectoryPicker(): void {
    const draft = this.#view.value.draft;

    if (draft.runnerId.length > 0) {
      void this.#directoryPicker.open(
        draft.runnerId,
        draft.workingDirectory.trim() || "~",
      );
    }
  }

  removeImage(index: number, target: "draft" | "followUp"): void {
    this.#removeImage(index, target);
  }

  retryModels(): void {
    this.#models.ensure(this.#view.value.draft.credential, true);
  }

  select(sessionId: string): Promise<void> {
    return this.#select(sessionId);
  }

  send(): Promise<void> {
    return this.#send();
  }

  #patchDraft(values: Partial<SessionViewState["draft"]>): void {
    this.#view.patch({ draft: { ...this.#view.value.draft, ...values } });
  }

  setDraftField(name: "prompt" | "workingDirectory", value: string): void {
    this.#patchDraft({ [name]: value });
  }

  setFollowUp(value: string): void {
    this.#view.patch({ followUp: value });
  }

  setTools(tools: readonly AgentSessionToolName[]): void {
    this.#patchDraft({ tools: [...tools] });
  }

  stop(): Promise<void> {
    return this.#stop();
  }

  toggleAutoCompact(autoCompact: boolean): Promise<void> {
    return this.#toggleAutoCompact(autoCompact);
  }

  setTranscriptFilter(
    name: SessionTranscriptFilterName,
    visible: boolean,
  ): void {
    const transcriptFilters = {
      ...this.#view.value.transcriptFilters,
      [name]: visible,
    };
    this.#view.patch({ transcriptFilters });
    writeSessionTranscriptFilters(
      this.#transcriptFilterStorage,
      transcriptFilters,
    );
  }

  toggleSelect(
    name: "credential" | "model" | "reasoningEffort" | "runnerId",
  ): void {
    this.#view.patch({
      openSelect: this.#view.value.openSelect === name ? undefined : name,
    });
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
          const selectedId = this.#applyInitialSessions(sessions);
          await this.#readSelectedDetail(selectedId, revision);
        },
        error: "We could not load your agent sessions. Please try again.",
        failurePatch: { sessions: [] },
        revision,
      });
    } finally {
      this.#initialLoadPending = false;
      this.#continueRehydrate();
    }
  }

  reset(): void {
    const transcriptFilters = readSessionTranscriptFilters(
      this.#transcriptFilterStorage,
    );
    this.#initialLoadPending = false;
    this.#rehydratePending = false;
    this.#directoryPicker.reset();
    this.#models.reset();
    this.#realtime.reset();
    this.#view.reset({ ...initialSessionViewState(), transcriptFilters });
  }

  #sessionMutationPending(): boolean {
    return this.#view.value.creating || detailMutationPending(this.#view.value);
  }

  #continueRehydrate(): void {
    if (
      !this.#rehydratePending ||
      this.#initialLoadPending ||
      this.#sessionMutationPending()
    ) {
      return;
    }
    this.#rehydratePending = false;
    void this.#rehydrate();
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
        await this.#readSelectedDetail(selectedId, revision);
      },
      error: "The realtime connection could not restore this session.",
      failurePatch: { loadingDetail: false },
      revision,
    });
  }

  async #create(): Promise<void> {
    const credential = selectedSessionCredential(
      this.#view.value.draft.credential,
    );

    if (
      credential === undefined ||
      this.#view.value.draft.runnerId.length === 0 ||
      this.#view.value.draft.model.length === 0 ||
      (this.#view.value.draft.prompt.trim().length === 0 &&
        this.#view.value.draft.images.length === 0) ||
      this.#view.value.draft.workingDirectory.trim().length === 0
    ) {
      this.#view.patch({
        error:
          "Choose a runner, credential, and model, then describe the task.",
      });
      return;
    }

    const revision = this.#view.begin({ creating: true, error: undefined });

    try {
      const detail = readSessionDetail(
        await this.#transport.command(SESSION_REALTIME_OPERATIONS.create, {
          ...(this.#view.value.draft.images.length === 0
            ? {}
            : { images: this.#view.value.draft.images }),
          ...credential,
          model: this.#view.value.draft.model.trim(),
          prompt: this.#view.value.draft.prompt.trim(),
          ...(this.#view.value.draft.reasoningEffort.length === 0
            ? {}
            : { reasoningEffort: this.#view.value.draft.reasoningEffort }),
          runnerId: this.#view.value.draft.runnerId,
          tools: this.#view.value.draft.tools,
          workingDirectory: this.#view.value.draft.workingDirectory.trim(),
        }),
      );

      this.#view.patchCurrent(
        revision,
        this.#detailState(detail, {
          creating: false,
          draft: {
            ...this.#view.value.draft,
            images: [],
            prompt: "",
          },
          selectedId: detail.id,
        }),
      );
    } catch (error) {
      this.#patchMutationError(revision, error, "start that session", {
        creating: false,
      });
    } finally {
      this.#continueRehydrate();
    }
  }

  async #readDetail(
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
        const detailState = this.#detailState(detail, {
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

  async #addImages(files: readonly File[], follow: boolean): Promise<void> {
    const current = follow
      ? this.#view.value.followUpImages
      : this.#view.value.draft.images;
    try {
      const images = await appendAgentImageFiles(current, files);
      this.#view.patch(
        follow
          ? { error: undefined, followUpImages: images }
          : {
              draft: { ...this.#view.value.draft, images },
              error: undefined,
            },
      );
    } catch (error) {
      this.#view.patch({
        error:
          error instanceof Error
            ? error.message
            : "We could not attach those images.",
      });
    }
  }

  #removeImage(index: number, target: "draft" | "followUp"): void {
    const images =
      target === "draft"
        ? this.#view.value.draft.images
        : this.#view.value.followUpImages;

    if (!Number.isSafeInteger(index) || index < 0 || index >= images.length) {
      return;
    }

    const remaining = images.filter(
      (_image, imageIndex) => imageIndex !== index,
    );
    this.#view.patch(
      target === "draft"
        ? { draft: { ...this.#view.value.draft, images: remaining } }
        : { followUpImages: remaining },
    );
  }

  async #select(sessionId: string): Promise<void> {
    if (
      sessionId === this.#view.value.selectedId &&
      this.#view.value.detail !== undefined
    ) {
      return;
    }

    const revision = this.#view.begin({
      detail: undefined,
      error: undefined,
      followUp: "",
      followUpImages: [],
      loadingDetail: true,
      selectedId: sessionId,
    });
    await this.#readDetail(sessionId, revision, true);
  }

  async #send(): Promise<void> {
    const sessionId = this.#view.value.selectedId;
    const detail = this.#view.value.detail;
    const prompt = this.#view.value.followUp.trim();

    if (
      sessionId === undefined ||
      detail?.id !== sessionId ||
      detail.status === "queued" ||
      detail.status === "running" ||
      this.#detailMutationPending() ||
      (prompt.length === 0 && this.#view.value.followUpImages.length === 0)
    ) {
      return;
    }

    await this.#mutateDetail({
      action: "send that instruction",
      operation: SESSION_REALTIME_OPERATIONS.send,
      payload: {
        ...(this.#view.value.followUpImages.length === 0
          ? {}
          : { images: this.#view.value.followUpImages }),
        prompt,
        sessionId,
      },
      pending: "sending",
      success: { followUp: "", followUpImages: [] },
    });
  }

  async #mutateWhen(
    allowed: (status: AgentSessionStatus) => boolean,
    mutation: (sessionId: string) => SessionMutation,
  ): Promise<void> {
    if (
      !this.#detailMutationPending() &&
      selectedDetailHasStatus(this.#view.value, allowed)
    ) {
      await this.#mutateSelected(mutation);
    }
  }

  async #compact(): Promise<void> {
    await this.#mutateWhen(sessionCanResume, compactSessionMutation);
  }

  async #toggleAutoCompact(autoCompact: boolean): Promise<void> {
    const sessionId = this.#view.value.selectedId;
    if (
      sessionId === undefined ||
      this.#detailMutationPending() ||
      !selectedDetailHasStatus(this.#view.value, sessionCanResume)
    ) {
      return;
    }

    await this.#mutateDetail(compactionModeMutation(sessionId, autoCompact));
  }

  async #continue(): Promise<void> {
    await this.#mutateWhen(sessionCanResume, continueSessionMutation);
  }

  async #stop(): Promise<void> {
    await this.#mutateWhen(sessionIsActive, stopSessionMutation);
  }

  #detailMutationPending(): boolean {
    return detailMutationPending(this.#view.value);
  }

  async #mutateSelected(
    create: (sessionId: string) => SessionMutation,
  ): Promise<void> {
    const mutation = selectedMutation(this.#view.value.selectedId, create);
    if (mutation !== undefined) {
      await this.#mutateDetail(mutation);
    }
  }

  async #mutateDetail(
    options: SessionMutation & {
      readonly success?: Partial<SessionViewState>;
    },
  ): Promise<void> {
    const pending = { [options.pending]: true };
    const settled = { [options.pending]: false };
    const revision = this.#view.begin({ error: undefined, ...pending });

    try {
      const detail = await executeSessionMutation(this.#transport, options);

      if (
        this.#view.patchCurrent(revision, {
          ...settled,
          ...options.success,
        })
      ) {
        this.#realtime.applyDetail(detail);
      }
    } catch (error) {
      this.#patchMutationError(revision, error, options.action, settled);
    } finally {
      this.#continueRehydrate();
    }
  }

  #detailState(
    detail: AgentSessionDetail,
    extra: Partial<SessionViewState>,
  ): Partial<SessionViewState> {
    const visibleDetail = retainUnchangedSessionData(
      this.#view.value.detail,
      detail,
    );
    return {
      detail: visibleDetail,
      sessions: replaceSessionSummary(
        this.#view.value.sessions ?? [],
        visibleDetail,
      ),
      ...extra,
    };
  }

  #patchMutationError(
    revision: number,
    error: unknown,
    action: string,
    settled: Partial<SessionViewState>,
  ): void {
    this.#view.patchCurrent(revision, {
      ...settled,
      error: sessionMutationError(error, action),
    });
  }
}
