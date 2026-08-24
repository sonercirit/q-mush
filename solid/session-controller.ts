import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AskQuestionAnswers } from "../shared/ask-questions.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { createDirectoryPickerController } from "./directory-picker-controller.ts";
import { createReactiveState } from "./reactive-state.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RealtimeStreamBatch } from "./realtime-stream-buffer.ts";
import { createRevisionState } from "./revision-state.ts";
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
import { createSessionLoadController } from "./session-controller-load.ts";
import type { SessionToolUpdateResult } from "./session-controller-options.ts";
import {
  createSessionPendingInputController,
  type PendingInputTimer,
} from "./session-controller-pending-input.ts";
import { updatedSessionQuestions } from "./session-controller-question-event.ts";
import { answerSessionQuestions } from "./session-controller-questions.ts";
import {
  createSessionReconciliationController,
  type DetailMutationOptions,
} from "./session-controller-reconciliation.ts";
import {
  createSessionRealtimeState,
  type SessionRealtimeState,
} from "./session-controller-state.ts";
import { updateSessionTools } from "./session-controller-tool-update.ts";
import {
  browserTranscriptFilterStorage,
  initialTranscriptFilters,
  updatedTranscriptFilters,
} from "./session-controller-transcript.ts";
import { selectedDraftOption } from "./session-form.ts";
import { loadSessionHistoryPage } from "./session-history-controller.ts";
import { createSessionModelController } from "./session-model-controller.ts";
import {
  continueSessionMutation,
  sendSessionMutation,
  stopSessionMutation,
} from "./session-mutations.ts";
import {
  runUnlessSessionMutation,
  sessionMutationPending,
} from "./session-pending.ts";
import { createSessionProviderController } from "./session-provider-controller.ts";
import { initialSessionViewState } from "./session-state.ts";
import type {
  SessionTranscriptFilterName,
  SessionTranscriptFilterStorage,
} from "./session-transcript-filters.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export function createSessionController(
  reactiveView = createReactiveState(initialSessionViewState()),
  directoryPicker = createDirectoryPickerController(),
  transcriptFilterStorage:
    | SessionTranscriptFilterStorage
    | null
    | undefined = browserTranscriptFilterStorage(),
  transport?: SessionCommandTransport,
  pendingInputTimer?: PendingInputTimer,
) {
  const storedTranscriptFilters = transcriptFilterStorage ?? undefined;
  const view = createRevisionState(reactiveView.state, reactiveView.setState);
  view.patch({
    transcriptFilters: initialTranscriptFilters(
      reactiveView.state(),
      storedTranscriptFilters,
    ),
  });
  const live = createSessionRealtimeState(view);
  const loader = createSessionLoadController(view, live, transport);
  const reconciliation = createSessionReconciliationController(view, loader);
  const models = createSessionModelController(view, transport);
  const providers = createSessionProviderController(view);
  const pendingInputs = createSessionPendingInputController({
    loader,
    realtime: live,
    transport,
    view,
    ...(pendingInputTimer && { timer: pendingInputTimer }),
  });

  transport?.onReconnect?.(() => {
    reconciliation.reconnect();
  });

  function applyDetail(detail: AgentSessionDetail): void {
    applySnapshot(() => {
      live.applyDetail(detail);
      pendingInputs.reconcile(detail);
    }, true);
    if (
      view.value.selectedId === detail.id &&
      view.value.history.page === undefined
    ) {
      showNewestSessionHistory(view, detail.hasOlderSegments);
    }
  }
  function applyNewestSnapshot(apply: () => void, blocked?: () => void): void {
    if (view.value.history.page === undefined) {
      applySnapshot(apply, false, blocked);
    }
  }
  function applyCompaction(
    event: Parameters<SessionRealtimeState["applyCompaction"]>[0],
  ) {
    if (event.type === "session_compaction_settled") {
      live.applyCompaction(event);
      return;
    }
    applyNewestSnapshot(() => {
      live.applyCompaction(event);
    });
  }
  function applyStreamBatch(event: RealtimeStreamBatch): void {
    applyNewestSnapshot(
      () => {
        live.applyStreamBatch(event);
      },
      () => {
        live.freezeStreamBatch(event);
      },
    );
  }
  function applyQuestions(
    event: Extract<RealtimeServerEvent, { type: "session_questions" }>,
  ): void {
    applySnapshot(() => {
      const detail = updatedSessionQuestions(view.value.detail, event);
      if (detail !== undefined) {
        live.applyDetail(detail);
      }
    });
  }
  function applyToolSnapshot(
    event: Parameters<SessionRealtimeState["applyToolSnapshot"]>[0],
  ) {
    applyNewestSnapshot(
      () => {
        live.applyToolSnapshot(event);
      },
      () => {
        live.rebaseStream(event.sessionId);
      },
    );
  }
  function applySnapshot(
    apply: () => void,
    applyWhileSending = false,
    blocked?: () => void,
  ): void {
    if (
      !sessionMutationPending(view.value) ||
      (applyWhileSending && view.value.sending)
    ) {
      apply();
    } else {
      blocked?.();
    }
  }
  function applyRealtime(sessions: readonly AgentSessionSummary[]): void {
    applySnapshot(() => {
      live.applySessions(sessions);
    });
  }
  function addImages(files: readonly File[], follow: boolean) {
    return addSessionImages({ files, follow, view: view });
  }
  function answerQuestions(answers: AskQuestionAnswers) {
    return answerSessionQuestions({
      answers,
      realtime: live,
      transport,
      view,
    });
  }
  function chooseDirectory(): void {
    const workingDirectory = directoryPicker.choose();
    if (workingDirectory !== undefined) {
      if (view.value.detail?.runnerRequired === true) {
        patchReassignment({ workingDirectory });
      } else {
        controller.setDraftField("workingDirectory", workingDirectory);
      }
    }
  }
  function chooseOption(
    name: string,
    value: string,
    availableValues: readonly string[],
  ): void {
    const panel = view.value;
    const draft = selectedDraftOption(panel, name, value, availableValues);
    if (draft === undefined) {
      return;
    }
    view.patch({ draft, openSelect: undefined });
    if (name === "credential") {
      providers.clear();
      models.ensure(value);
    } else if (name === "model") {
      providers.ensure(draft.credential, draft.model);
    }
  }
  function chooseReassignmentRunner(
    runnerId: string,
    availableValues: readonly string[],
  ): void {
    if (!availableValues.includes(runnerId)) {
      return;
    }
    view.patch({
      openSelect: undefined,
      reassignment: { runnerId, workingDirectory: "" },
    });
  }
  function compact(continueAfter = false) {
    return compactSessionFromView(
      (mutation, allowed) => mutateRecoverable(mutation, allowed),
      continueAfter,
    );
  }
  function cancelPendingInput(inputId: string) {
    return pendingInputs.cancel(inputId);
  }
  function continueSession() {
    return continueMutation();
  }
  function create() {
    return createSessionFromView({
      loader,
      realtime: live,
      reconciliation,
      transport,
      view,
    });
  }
  function initializeDefaults(
    runnerId: string,
    credential: string,
    credentialsSettled: boolean,
  ): void {
    initializeSessionDefaults(
      controller,
      runnerId,
      credential,
      credentialsSettled,
    );
  }
  function ensureModels(credential: string): void {
    models.ensure(credential);
  }
  function replaceDraft(draft: SessionViewState["draft"]): void {
    view.patch({ draft });
  }
  function openDirectoryPicker(): void {
    openSessionDirectoryPicker(controller);
  }
  function reassign(onlineRunnerIds: readonly string[]) {
    return reassignSessionFromView(mutationDependencies(), onlineRunnerIds);
  }
  function removeImage(index: number, target: "draft" | "followUp"): void {
    removeSessionControllerImage({ index, target, view: view });
  }
  function retryModels(): void {
    models.ensure(view.value.draft.credential, true);
  }
  function retryProviders(): void {
    const draft = view.value.draft;
    providers.ensure(draft.credential, draft.model, true);
  }
  function ensureProviders(credential: string, model: string): void {
    providers.ensure(credential, model);
  }
  function select(sessionId: string) {
    showNewestSessionHistory(view, false);
    return loader.select(sessionId);
  }
  async function history(direction: "newer" | "older"): Promise<void> {
    const history = view.value.history;
    const detail = view.value.detail;
    if (detail === undefined || history.loading) {
      return;
    }
    if (direction === "older") {
      const canGoOlder =
        history.page === undefined
          ? detail.hasOlderSegments
          : history.canGoOlder;
      if (canGoOlder) {
        await loadHistory(
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
      showNewestSessionHistory(view, detail.hasOlderSegments);
      return;
    }
    await loadHistory(detail.id, history.page.newerCursor, detail.workspaceId);
  }

  function olderHistory() {
    return history("older");
  }
  function newerHistory() {
    return history("newer");
  }
  function patchHistory(patch: Partial<SessionViewState["history"]>): void {
    view.patch({
      history: { ...view.value.history, ...patch },
    });
  }

  async function loadHistory(
    sessionId: string,
    cursor: string | null,
    workspaceId: string,
  ): Promise<void> {
    if (transport === undefined) {
      patchHistory({
        error: "Historical transcript browsing requires realtime.",
      });
      return;
    }

    patchHistory({ error: undefined, loading: true });
    try {
      const page = await loadSessionHistoryPage(
        transport,
        sessionId,
        cursor,
        workspaceId,
      );
      if (view.value.selectedId === sessionId) {
        patchHistory({
          canGoOlder: page.olderCursor !== null,
          error: undefined,
          loading: false,
          page,
        });
      }
    } catch {
      if (view.value.selectedId === sessionId) {
        patchHistory({
          error: "We could not load that historical transcript page.",
          loading: false,
        });
      }
    }
  }
  function followUp() {
    return pendingInputs.submit("follow_up");
  }
  function retryPendingInput(clientRequestId: string) {
    return pendingInputs.retry(clientRequestId);
  }
  function fork(
    messageId: string,
    selection?: Parameters<typeof forkSessionFromView>[0]["selection"],
  ) {
    return forkSessionFromView({
      forkPointMessageId: messageId,
      loader,
      realtime: live,
      reconciliation,
      selection,
      transport,
      view,
    });
  }
  function send() {
    return sendMutation();
  }
  function patchReassignment(
    values: Partial<SessionViewState["reassignment"]>,
  ): void {
    view.patch({
      reassignment: { ...view.value.reassignment, ...values },
    });
  }
  function patchDraftValues(values: Partial<SessionViewState["draft"]>): void {
    const draft = { ...view.value.draft, ...values };
    view.patch({ draft });
  }
  const setDraftFlag = (
    name: "autoCompact" | "idleCompact",
    value: boolean,
  ): void => {
    patchDraftValues({ [name]: value });
  };
  function setDraftField(
    name:
      "agentFilePath" | "prompt" | "userContextTokenCap" | "workingDirectory",
    value: string,
  ): void {
    patchDraftValues({ [name]: value });
  }
  function insertPrompt(value: string, replace = false): boolean {
    if (!replace && view.value.draft.prompt.length > 0) {
      return false;
    }
    patchDraftValues({ prompt: value });
    return true;
  }
  function setFollowUp(value: string): void {
    view.patch({ followUp: value });
  }
  function setReassignmentDirectory(value: string): void {
    patchReassignment({ workingDirectory: value });
  }
  function setTools(tools: readonly AgentSessionToolName[]): void {
    patchDraftValues({ tools: [...tools] });
  }
  async function updateTools(
    tools: readonly AgentSessionToolName[],
    confirmedCacheDrop: boolean,
  ): Promise<SessionToolUpdateResult> {
    return updateSessionTools({
      confirmedCacheDrop,
      realtime: live,
      tools,
      transport,
      view,
    });
  }
  function setWorkspace(workspaceId: string): void {
    providers.setWorkspace(workspaceId);
  }
  function stop(cascade?: boolean): Promise<void> {
    return stopMutation(cascade);
  }
  function steer(): Promise<void> {
    return pendingInputs.submit("steer");
  }
  function toggleCompactionFlag(
    name: "autoCompact" | "idleCompact",
    enabled: boolean,
  ): Promise<void> {
    return toggleSessionCompactionFlag({
      enabled,
      mutate: (mutation) => mutateDetail(mutation),
      name,
      view,
    });
  }
  function setContextTokenCap(cap: number | null, compact = false) {
    return updateSessionContextTokenCap(controller, cap, compact);
  }
  function mutateContextTokenCap(
    mutation: Parameters<typeof mutateSessionDetail>[1],
  ) {
    return mutateSessionDetail(mutationDependencies(), mutation, true);
  }
  function setTranscriptFilter(
    name: SessionTranscriptFilterName,
    visible: boolean,
  ): void {
    view.patch({
      transcriptFilters: updatedTranscriptFilters(
        view.value.transcriptFilters,
        name,
        visible,
        storedTranscriptFilters,
      ),
    });
  }
  function toggleReassignmentRunner(): void {
    toggleOpenSelect("reassignmentRunnerId");
  }
  function toggleOpenSelect(
    name: NonNullable<SessionViewState["openSelect"]>,
  ): void {
    view.patch({
      openSelect: view.value.openSelect === name ? undefined : name,
    });
  }
  function toggleSelect(
    name:
      | "credential"
      | "executionEnvironment"
      | "model"
      | "openRouterProviderTag"
      | "reasoningEffort"
      | "runnerId",
  ): void {
    toggleOpenSelect(name);
  }
  function loadUnlessPending(refresh: boolean): Promise<void> {
    return runUnlessSessionMutation(
      view.value,
      () => (refresh ? loader.refresh() : loader.load()),
      Promise.resolve(),
    );
  }

  function load(): Promise<void> {
    return loadUnlessPending(false);
  }
  function refresh(): Promise<void> {
    return loadUnlessPending(true);
  }
  function reset(): void {
    const transcriptFilters = initialTranscriptFilters(
      view.value,
      storedTranscriptFilters,
    );
    directoryPicker.reset();
    models.reset();
    pendingInputs.reset();
    providers.reset();
    reconciliation.reset();
    loader.reset();
    live.reset();
    view.reset({ ...initialSessionViewState(), transcriptFilters });
  }
  async function sendMutation(): Promise<void> {
    const sessionId = view.value.selectedId;
    const detail = view.value.detail;
    const prompt = view.value.followUp.trim();
    if (
      sessionId === undefined ||
      detail?.id !== sessionId ||
      detail.status === "queued" ||
      detail.status === "running" ||
      detail.runnerRequired ||
      sessionMutationPending(view.value) ||
      (prompt.length === 0 && view.value.followUpImages.length === 0)
    ) {
      return;
    }
    await mutateDetail({
      ...sendSessionMutation(sessionId, prompt, view.value.followUpImages),
      success: { followUp: "", followUpImages: [] },
    });
  }
  async function mutateWhen(
    allowed: (status: AgentSessionStatus) => boolean,
    mutation: Parameters<typeof selectedMutation>[1],
  ): Promise<void> {
    if (
      sessionMutationPending(view.value) ||
      !selectedDetailHasStatus(view.value, allowed)
    ) {
      return;
    }
    await mutateSelected(mutation);
  }
  async function mutateRecoverable(
    mutation: Parameters<typeof selectedMutation>[1],
    allowed = sessionCanResume,
  ): Promise<void> {
    if (view.value.detail?.runnerRequired !== true) {
      await mutateWhen(allowed, mutation);
    }
  }
  async function continueMutation(): Promise<void> {
    await mutateRecoverable(continueSessionMutation);
  }
  async function stopMutation(cascade?: boolean): Promise<void> {
    await mutateWhen(sessionIsActive, (sessionId) =>
      stopSessionMutation(sessionId, cascade),
    );
  }
  async function mutateSelected(
    create: Parameters<typeof selectedMutation>[1],
  ): Promise<void> {
    const mutation = selectedMutation(view.value.selectedId, create);
    if (mutation !== undefined) {
      await mutateDetail(mutation);
    }
  }
  async function mutateDetail(options: DetailMutationOptions): Promise<void> {
    await mutateSessionDetail(mutationDependencies(), options);
  }
  function mutationDependencies() {
    const shared = {
      loader,
      transport,
      view,
    };
    return {
      ...shared,
      realtime: live,
      reconciliation,
    };
  }

  const controller = {
    applyDetail,
    applyCompaction,
    applyStreamBatch,
    applyQuestions,
    applyToolSnapshot,
    applyRealtime,
    addImages,
    answerQuestions,
    chooseDirectory,
    chooseOption,
    chooseReassignmentRunner,
    compact,
    cancelPendingInput,
    continueSession,
    create,
    initializeDefaults,
    ensureModels,
    patchDraft: replaceDraft,
    openDirectoryPicker,
    reassign,
    removeImage,
    retryModels,
    retryProviders,
    ensureProviders,
    select,
    olderHistory,
    newerHistory,
    followUp,
    retryPendingInput,
    fork,
    send,
    setDraftFlag,
    setDraftField,
    insertPrompt,
    setFollowUp,
    setReassignmentDirectory,
    setTools,
    updateTools,
    setWorkspace,
    stop,
    steer,
    toggleCompactionFlag,
    setContextTokenCap,
    mutateContextTokenCap,
    setTranscriptFilter,
    toggleReassignmentRunner,
    toggleSelect,
    load,
    refresh,
    reset,
    get directoryPicker() {
      return directoryPicker;
    },
    get state() {
      return { ...view.value, directoryPicker: directoryPicker.state };
    },
    get view() {
      return reactiveView.state;
    },
    get transport() {
      return transport;
    },
  };
  return controller;
}

type SessionControllerSurface = ReturnType<typeof createSessionController>;

export interface SessionController extends SessionControllerSurface {
  readonly state: SessionViewState;
}
