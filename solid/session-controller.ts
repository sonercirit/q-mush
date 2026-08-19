import { type Accessor } from "solid-js";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AskQuestionAnswers } from "../shared/ask-questions.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { DirectoryPickerController } from "./directory-picker-controller.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RealtimeStreamBatch } from "./realtime-stream-buffer.ts";
import { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import {
  addSessionImages,
  mutateSessionDetail,
  reassignSessionFromView,
  removeSessionControllerImage,
} from "./session-controller-actions.ts";
import {
  compactSessionFromView,
  toggleSessionCompactionFlag,
} from "./session-controller-compaction.ts";
import { updateSessionContextTokenCap } from "./session-controller-context-cap.ts";
import { createSessionFromView } from "./session-controller-create.ts";
import {
  initializeSessionDefaults,
  openSessionDirectoryPicker,
} from "./session-controller-defaults.ts";
import { forkSessionFromView } from "./session-controller-fork.ts";
import {
  selectedDetailHasStatus,
  selectedMutation,
  sessionCanResume,
  sessionIsActive,
} from "./session-controller-guards.ts";
import { showNewestSessionHistory } from "./session-controller-history.ts";
import { SessionLoadController } from "./session-controller-load.ts";
import type { SessionToolUpdateResult } from "./session-controller-options.ts";
import {
  SessionPendingInputController,
  type PendingInputTimer,
} from "./session-controller-pending-input.ts";
import { updatedSessionQuestions } from "./session-controller-question-event.ts";
import { answerSessionQuestions } from "./session-controller-questions.ts";
import {
  SessionReconciliationController,
  type DetailMutationOptions,
} from "./session-controller-reconciliation.ts";
import { SessionRealtimeState } from "./session-controller-state.ts";
import { updateSessionTools } from "./session-controller-tool-update.ts";
import {
  browserTranscriptFilterStorage,
  initialTranscriptFilters,
  updatedTranscriptFilters,
} from "./session-controller-transcript.ts";
import { selectedDraftOption } from "./session-form.ts";
import { loadSessionHistoryPage } from "./session-history-controller.ts";
import { SessionModelController } from "./session-model-controller.ts";
import {
  continueSessionMutation,
  sendSessionMutation,
  stopSessionMutation,
} from "./session-mutations.ts";
import {
  runUnlessSessionMutation,
  sessionMutationPending,
} from "./session-pending.ts";
import { SessionProviderController } from "./session-provider-controller.ts";
import { initialSessionViewState } from "./session-state.ts";
import type {
  SessionTranscriptFilterName,
  SessionTranscriptFilterStorage,
} from "./session-transcript-filters.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export class SessionController {
  readonly #directoryPicker: DirectoryPickerController;
  readonly #loader: SessionLoadController;
  readonly #models: SessionModelController;
  readonly #providers: SessionProviderController;
  readonly #pendingInputs: SessionPendingInputController;
  readonly #live: SessionRealtimeState;
  readonly #reconciliation: SessionReconciliationController;
  readonly #transcriptFilterStorage: SessionTranscriptFilterStorage | undefined;
  readonly #transport: SessionCommandTransport | undefined;
  readonly #view: RevisionState<SessionViewState>;
  readonly #reactiveView: ReactiveState<SessionViewState>;
  constructor(
    reactiveView = createReactiveState(initialSessionViewState()),
    directoryPicker = new DirectoryPickerController(),
    transcriptFilterStorage:
      | SessionTranscriptFilterStorage
      | null
      | undefined = browserTranscriptFilterStorage(),
    transport?: SessionCommandTransport,
    pendingInputTimer?: PendingInputTimer,
  ) {
    this.#reactiveView = reactiveView;
    this.#view = new RevisionState(reactiveView.state, reactiveView.setState);
    this.#view.patch({
      transcriptFilters: initialTranscriptFilters(
        reactiveView.state(),
        transcriptFilterStorage,
      ),
    });
    this.#live = new SessionRealtimeState(this.#view);
    this.#loader = new SessionLoadController(this.#view, this.#live, transport);
    this.#reconciliation = new SessionReconciliationController(
      this.#view,
      this.#loader,
    );
    this.#models = new SessionModelController(this.#view, transport);
    this.#providers = new SessionProviderController(this.#view);
    this.#pendingInputs = new SessionPendingInputController({
      loader: this.#loader,
      realtime: this.#live,
      transport,
      view: this.#view,
      ...(pendingInputTimer && { timer: pendingInputTimer }),
    });
    this.#directoryPicker = directoryPicker;
    this.#transcriptFilterStorage = transcriptFilterStorage ?? undefined;
    this.#transport = transport;
    transport?.onReconnect?.(() => {
      this.#reconciliation.reconnect();
    });
  }

  applyDetail(detail: AgentSessionDetail): void {
    this.#applySnapshot(() => {
      this.#live.applyDetail(detail);
      this.#pendingInputs.reconcile(detail);
    }, true);
    if (
      this.#view.value.selectedId === detail.id &&
      this.#view.value.history.page === undefined
    ) {
      showNewestSessionHistory(this.#view, detail.hasOlderSegments);
    }
  }
  #applyNewestSnapshot(apply: () => void, blocked?: () => void): void {
    if (this.#view.value.history.page === undefined) {
      this.#applySnapshot(apply, false, blocked);
    }
  }
  applyCompaction(
    event: Parameters<SessionRealtimeState["applyCompaction"]>[0],
  ) {
    if (event.type === "session_compaction_settled") {
      this.#live.applyCompaction(event);
      return;
    }
    this.#applyNewestSnapshot(() => {
      this.#live.applyCompaction(event);
    });
  }
  applyStreamBatch(event: RealtimeStreamBatch): void {
    this.#applyNewestSnapshot(
      () => {
        this.#live.applyStreamBatch(event);
      },
      () => {
        this.#live.freezeStreamBatch(event);
      },
    );
  }
  applyQuestions(
    event: Extract<RealtimeServerEvent, { type: "session_questions" }>,
  ): void {
    this.#applySnapshot(() => {
      const detail = updatedSessionQuestions(this.#view.value.detail, event);
      if (detail !== undefined) {
        this.#live.applyDetail(detail);
      }
    });
  }
  applyToolSnapshot(
    event: Parameters<SessionRealtimeState["applyToolSnapshot"]>[0],
  ) {
    this.#applyNewestSnapshot(
      () => {
        this.#live.applyToolSnapshot(event);
      },
      () => {
        this.#live.rebaseStream(event.sessionId);
      },
    );
  }
  #applySnapshot(
    apply: () => void,
    applyWhileSending = false,
    blocked?: () => void,
  ): void {
    if (
      !sessionMutationPending(this.#view.value) ||
      (applyWhileSending && this.#view.value.sending)
    ) {
      apply();
    } else {
      blocked?.();
    }
  }
  applyRealtime(sessions: readonly AgentSessionSummary[]): void {
    this.#applySnapshot(() => {
      this.#live.applySessions(sessions);
    });
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
  get transport(): SessionCommandTransport | undefined {
    return this.#transport;
  }
  addImages(files: readonly File[], follow: boolean) {
    return addSessionImages({ files, follow, view: this.#view });
  }
  answerQuestions(answers: AskQuestionAnswers) {
    return answerSessionQuestions({
      answers,
      realtime: this.#live,
      transport: this.#transport,
      view: this.#view,
    });
  }
  chooseDirectory(): void {
    const workingDirectory = this.#directoryPicker.choose();
    if (workingDirectory !== undefined) {
      if (this.#view.value.detail?.runnerRequired === true) {
        this.#patchReassignment({ workingDirectory });
      } else {
        this.setDraftField("workingDirectory", workingDirectory);
      }
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
      this.#providers.clear();
      this.#models.ensure(value);
    } else if (name === "model") {
      this.#providers.ensure(draft.credential, draft.model);
    }
  }
  chooseReassignmentRunner(
    runnerId: string,
    availableValues: readonly string[],
  ): void {
    if (!availableValues.includes(runnerId)) {
      return;
    }
    this.#view.patch({
      openSelect: undefined,
      reassignment: { runnerId, workingDirectory: "" },
    });
  }
  compact(continueAfter = false) {
    return compactSessionFromView(
      (mutation, allowed) => this.#mutateRecoverable(mutation, allowed),
      continueAfter,
    );
  }
  cancelPendingInput(inputId: string) {
    return this.#pendingInputs.cancel(inputId);
  }
  continueSession() {
    return this.#continue();
  }
  create() {
    return createSessionFromView({
      loader: this.#loader,
      realtime: this.#live,
      reconciliation: this.#reconciliation,
      transport: this.#transport,
      view: this.#view,
    });
  }
  initializeDefaults(
    runnerId: string,
    credential: string,
    credentialsSettled: boolean,
  ): void {
    initializeSessionDefaults(this, runnerId, credential, credentialsSettled);
  }
  ensureModels(credential: string): void {
    this.#models.ensure(credential);
  }
  patchDraft(draft: SessionViewState["draft"]): void {
    this.#view.patch({ draft });
  }
  openDirectoryPicker(): void {
    openSessionDirectoryPicker(this);
  }
  reassign(onlineRunnerIds: readonly string[]) {
    return reassignSessionFromView(
      this.#mutationDependencies(),
      onlineRunnerIds,
    );
  }
  removeImage(index: number, target: "draft" | "followUp"): void {
    removeSessionControllerImage({ index, target, view: this.#view });
  }
  retryModels(): void {
    this.#models.ensure(this.#view.value.draft.credential, true);
  }
  retryProviders(): void {
    const draft = this.#view.value.draft;
    this.#providers.ensure(draft.credential, draft.model, true);
  }
  ensureProviders(credential: string, model: string): void {
    this.#providers.ensure(credential, model);
  }
  select(sessionId: string) {
    showNewestSessionHistory(this.#view, false);
    return this.#loader.select(sessionId);
  }
  async #history(direction: "newer" | "older"): Promise<void> {
    const history = this.#view.value.history;
    const detail = this.#view.value.detail;
    if (detail === undefined || history.loading) {
      return;
    }
    if (direction === "older") {
      const canGoOlder =
        history.page === undefined
          ? detail.hasOlderSegments
          : history.canGoOlder;
      if (canGoOlder) {
        await this.#loadHistory(
          detail.id,
          history.page?.olderCursor ?? null,
          detail.workspaceId,
        );
      }
      return;
    }
    if (history.page === undefined) {
      return;
    }
    if (history.page.newerCursor === null) {
      showNewestSessionHistory(this.#view, detail.hasOlderSegments);
      return;
    }
    await this.#loadHistory(
      detail.id,
      history.page.newerCursor,
      detail.workspaceId,
    );
  }

  olderHistory() {
    return this.#history("older");
  }
  newerHistory() {
    return this.#history("newer");
  }
  #patchHistory(patch: Partial<SessionViewState["history"]>): void {
    this.#view.patch({
      history: { ...this.#view.value.history, ...patch },
    });
  }

  async #loadHistory(
    sessionId: string,
    cursor: string | null,
    workspaceId: string,
  ): Promise<void> {
    if (this.#transport === undefined) {
      this.#patchHistory({
        error: "Historical transcript browsing requires realtime.",
      });
      return;
    }

    this.#patchHistory({ error: undefined, loading: true });
    try {
      const page = await loadSessionHistoryPage(
        this.#transport,
        sessionId,
        cursor,
        workspaceId,
      );
      if (this.#view.value.selectedId === sessionId) {
        this.#patchHistory({
          canGoOlder: page.olderCursor !== null,
          error: undefined,
          loading: false,
          page,
        });
      }
    } catch {
      if (this.#view.value.selectedId === sessionId) {
        this.#patchHistory({
          error: "We could not load that historical transcript page.",
          loading: false,
        });
      }
    }
  }
  followUp() {
    return this.#pendingInputs.submit("follow_up");
  }
  retryPendingInput(clientRequestId: string) {
    return this.#pendingInputs.retry(clientRequestId);
  }
  fork(
    messageId: string,
    selection?: Parameters<typeof forkSessionFromView>[0]["selection"],
  ) {
    return forkSessionFromView({
      forkPointMessageId: messageId,
      loader: this.#loader,
      realtime: this.#live,
      reconciliation: this.#reconciliation,
      selection,
      transport: this.#transport,
      view: this.#view,
    });
  }
  send() {
    return this.#send();
  }
  #patchReassignment(values: Partial<SessionViewState["reassignment"]>): void {
    this.#view.patch({
      reassignment: { ...this.#view.value.reassignment, ...values },
    });
  }
  #patchDraft(values: Partial<SessionViewState["draft"]>): void {
    const draft = { ...this.#view.value.draft, ...values };
    this.#view.patch({ draft });
  }
  readonly setDraftFlag = (
    name: "autoCompact" | "idleCompact",
    value: boolean,
  ): void => {
    this.#patchDraft({ [name]: value });
  };
  setDraftField(
    name:
      "agentFilePath" | "prompt" | "userContextTokenCap" | "workingDirectory",
    value: string,
  ): void {
    this.#patchDraft({ [name]: value });
  }
  insertPrompt(value: string, replace = false): boolean {
    if (!replace && this.#view.value.draft.prompt.length > 0) {
      return false;
    }
    this.#patchDraft({ prompt: value });
    return true;
  }
  setFollowUp(value: string): void {
    this.#view.patch({ followUp: value });
  }
  setReassignmentDirectory(value: string): void {
    this.#patchReassignment({ workingDirectory: value });
  }
  setTools(tools: readonly AgentSessionToolName[]): void {
    this.#patchDraft({ tools: [...tools] });
  }
  async updateTools(
    tools: readonly AgentSessionToolName[],
    confirmedCacheDrop: boolean,
  ): Promise<SessionToolUpdateResult> {
    return updateSessionTools({
      confirmedCacheDrop,
      realtime: this.#live,
      tools,
      transport: this.#transport,
      view: this.#view,
    });
  }
  setWorkspace(workspaceId: string): void {
    this.#providers.setWorkspace(workspaceId);
  }
  stop(cascade?: boolean): Promise<void> {
    return this.#stop(cascade);
  }
  steer(): Promise<void> {
    return this.#pendingInputs.submit("steer");
  }
  toggleCompactionFlag(
    name: "autoCompact" | "idleCompact",
    enabled: boolean,
  ): Promise<void> {
    return toggleSessionCompactionFlag({
      enabled,
      mutate: (mutation) => this.#mutateDetail(mutation),
      name,
      view: this.#view,
    });
  }
  setContextTokenCap(cap: number | null, compact = false) {
    return updateSessionContextTokenCap(this, cap, compact);
  }
  mutateContextTokenCap(mutation: Parameters<typeof mutateSessionDetail>[1]) {
    return mutateSessionDetail(this.#mutationDependencies(), mutation, true);
  }
  setTranscriptFilter(
    name: SessionTranscriptFilterName,
    visible: boolean,
  ): void {
    this.#view.patch({
      transcriptFilters: updatedTranscriptFilters(
        this.#view.value.transcriptFilters,
        name,
        visible,
        this.#transcriptFilterStorage,
      ),
    });
  }
  toggleReassignmentRunner(): void {
    this.#toggleOpenSelect("reassignmentRunnerId");
  }
  #toggleOpenSelect(name: NonNullable<SessionViewState["openSelect"]>): void {
    this.#view.patch({
      openSelect: this.#view.value.openSelect === name ? undefined : name,
    });
  }
  toggleSelect(
    name:
      | "credential"
      | "executionEnvironment"
      | "model"
      | "openRouterProviderTag"
      | "reasoningEffort"
      | "runnerId",
  ): void {
    this.#toggleOpenSelect(name);
  }
  #loadUnlessPending(refresh: boolean): Promise<void> {
    return runUnlessSessionMutation(
      this.#view.value,
      () => (refresh ? this.#loader.refresh() : this.#loader.load()),
      Promise.resolve(),
    );
  }

  load(): Promise<void> {
    return this.#loadUnlessPending(false);
  }
  refresh(): Promise<void> {
    return this.#loadUnlessPending(true);
  }
  reset(): void {
    const transcriptFilters = initialTranscriptFilters(
      this.#view.value,
      this.#transcriptFilterStorage,
    );
    this.#directoryPicker.reset();
    this.#models.reset();
    this.#pendingInputs.reset();
    this.#providers.reset();
    this.#reconciliation.reset();
    this.#loader.reset();
    this.#live.reset();
    this.#view.reset({ ...initialSessionViewState(), transcriptFilters });
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
      detail.runnerRequired ||
      sessionMutationPending(this.#view.value) ||
      (prompt.length === 0 && this.#view.value.followUpImages.length === 0)
    ) {
      return;
    }
    await this.#mutateDetail({
      ...sendSessionMutation(
        sessionId,
        prompt,
        this.#view.value.followUpImages,
      ),
      success: { followUp: "", followUpImages: [] },
    });
  }
  async #mutateWhen(
    allowed: (status: AgentSessionStatus) => boolean,
    mutation: Parameters<typeof selectedMutation>[1],
  ): Promise<void> {
    if (
      sessionMutationPending(this.#view.value) ||
      !selectedDetailHasStatus(this.#view.value, allowed)
    ) {
      return;
    }
    await this.#mutateSelected(mutation);
  }
  async #mutateRecoverable(
    mutation: Parameters<typeof selectedMutation>[1],
    allowed = sessionCanResume,
  ): Promise<void> {
    if (this.#view.value.detail?.runnerRequired !== true) {
      await this.#mutateWhen(allowed, mutation);
    }
  }
  async #continue(): Promise<void> {
    await this.#mutateRecoverable(continueSessionMutation);
  }
  async #stop(cascade?: boolean): Promise<void> {
    await this.#mutateWhen(sessionIsActive, (sessionId) =>
      stopSessionMutation(sessionId, cascade),
    );
  }
  async #mutateSelected(
    create: Parameters<typeof selectedMutation>[1],
  ): Promise<void> {
    const mutation = selectedMutation(this.#view.value.selectedId, create);
    if (mutation !== undefined) {
      await this.#mutateDetail(mutation);
    }
  }
  async #mutateDetail(options: DetailMutationOptions): Promise<void> {
    await mutateSessionDetail(this.#mutationDependencies(), options);
  }
  #mutationDependencies() {
    const shared = {
      loader: this.#loader,
      transport: this.#transport,
      view: this.#view,
    };
    return {
      ...shared,
      realtime: this.#live,
      reconciliation: this.#reconciliation,
    };
  }
}
