import { type Accessor } from "solid-js";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { SESSIONS_PATH } from "../shared/routes.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { requestJson } from "./browser-http.ts";
import { DirectoryPickerController } from "./directory-picker-controller.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import {
  selectedDetailHasStatus,
  selectedMutation,
  sessionCanResume,
  sessionIsActive,
} from "./session-controller-guards.ts";
import {
  selectedSessionCredential,
  sessionDataMatches,
  SessionRealtimeState,
} from "./session-controller-state.ts";
import {
  browserTranscriptFilterStorage,
  initialTranscriptFilters,
} from "./session-controller-transcript.ts";

import { selectedDraftOption } from "./session-form.ts";
import { appendAgentImageFiles } from "./session-image-input.ts";
import { SessionModelController } from "./session-model-controller.ts";
import {
  compactionModeMutation,
  compactSessionMutation,
  continueSessionMutation,
  executeSessionMutation,
  reassignSessionMutation,
  sessionMutationError,
  stopSessionMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import {
  sessionDetailMutationPending,
  sessionMutationPending,
} from "./session-pending.ts";
import {
  emptySessionReassignmentDraft,
  hasTrimmedText,
} from "./session-reassignment-client.ts";
import {
  initialSessionViewState,
  mostRecentSessionDirectory,
} from "./session-state.ts";
import {
  writeSessionTranscriptFilters,
  type SessionTranscriptFilterName,
  type SessionTranscriptFilterStorage,
} from "./session-transcript-filters.ts";

export class SessionController {
  readonly #directoryPicker: DirectoryPickerController;
  readonly #models: SessionModelController;
  readonly #realtime: SessionRealtimeState;
  readonly #transcriptFilterStorage: SessionTranscriptFilterStorage | undefined;
  readonly #view: RevisionState<SessionViewState>;
  readonly #reactiveView: ReactiveState<SessionViewState>;

  constructor(
    reactiveView = createReactiveState(initialSessionViewState()),
    directoryPicker = new DirectoryPickerController(),
    transcriptFilterStorage:
      | SessionTranscriptFilterStorage
      | null
      | undefined = browserTranscriptFilterStorage(),
  ) {
    this.#reactiveView = reactiveView;
    this.#view = new RevisionState(reactiveView.state, reactiveView.setState);
    this.#view.patch({
      transcriptFilters: initialTranscriptFilters(
        reactiveView.state(),
        transcriptFilterStorage,
      ),
    });
    this.#realtime = new SessionRealtimeState(this.#view);
    this.#models = new SessionModelController(this.#view);
    this.#directoryPicker = directoryPicker;
    this.#transcriptFilterStorage = transcriptFilterStorage ?? undefined;
  }

  applyDetail(detail: AgentSessionDetail): void {
    if (sessionMutationPending(this.#view.value)) {
      return;
    }
    this.#realtime.applyDetail(detail);
  }

  applyDelta(event: Parameters<SessionRealtimeState["applyDelta"]>[0]): void {
    this.#realtime.applyDelta(event);
  }

  applyRealtime(sessions: readonly AgentSessionSummary[]): void {
    this.#realtime.applySessions(sessions);
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
      this.#models.ensure(value);
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
    const required = this.#view.value.detail?.runnerRequired === true;
    const selection = required
      ? this.#view.value.reassignment
      : this.#view.value.draft;

    if (selection.runnerId.length > 0) {
      void this.#directoryPicker.open(
        selection.runnerId,
        selection.workingDirectory.trim() || "~",
      );
    }
  }

  reassign(onlineRunnerIds: readonly string[]): Promise<void> {
    return this.#reassign(onlineRunnerIds);
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

  #patchReassignment(values: Partial<SessionViewState["reassignment"]>): void {
    this.#view.patch({
      reassignment: { ...this.#view.value.reassignment, ...values },
    });
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

  setReassignmentDirectory(value: string): void {
    this.#patchReassignment({ workingDirectory: value });
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

  toggleReassignmentRunner(): void {
    this.#toggleOpenSelect("reassignmentRunnerId");
  }

  #toggleOpenSelect(name: NonNullable<SessionViewState["openSelect"]>): void {
    this.#view.patch({
      openSelect: this.#view.value.openSelect === name ? undefined : name,
    });
  }

  toggleSelect(
    name: "credential" | "model" | "reasoningEffort" | "runnerId",
  ): void {
    this.#toggleOpenSelect(name);
  }

  async load(): Promise<void> {
    const revision = this.#view.begin({
      detail: undefined,
      error: undefined,
      loadingDetail: false,
      selectedId: undefined,
      sessions: undefined,
    });
    await this.#loadSessions(revision, true);
  }

  reset(): void {
    const transcriptFilters = initialTranscriptFilters(
      this.#view.value,
      this.#transcriptFilterStorage,
    );
    this.#directoryPicker.reset();
    this.#models.reset();
    this.#realtime.reset();
    this.#view.reset({ ...initialSessionViewState(), transcriptFilters });
  }

  async #loadSessions(revision: number, initial: boolean): Promise<void> {
    try {
      const sessions = readSessionList(await requestJson(SESSIONS_PATH));

      if (!this.#view.isCurrent(revision)) {
        return;
      }

      const previousId = initial ? undefined : this.#view.value.selectedId;
      const selectedId =
        previousId !== undefined && sessions.some(({ id }) => id === previousId)
          ? previousId
          : sessions[0]?.id;

      if (
        selectedId !== this.#view.value.selectedId ||
        !sessionDataMatches(this.#view.value.sessions, sessions)
      ) {
        this.#patchDraft({
          workingDirectory: mostRecentSessionDirectory(sessions),
        });
        this.#view.patch({
          selectedId,
          sessions,
        });
      }

      if (selectedId === undefined) {
        if (this.#view.value.detail !== undefined) {
          this.#view.patch({ detail: undefined });
        }
      } else {
        await this.#readDetail(selectedId, revision, initial);
      }
    } catch {
      if (initial) {
        this.#view.patchCurrent(revision, {
          error: "We could not load your agent sessions. Please try again.",
          sessions: [],
        });
      }
    }
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
        await requestJson(SESSIONS_PATH, {
          body: JSON.stringify({
            ...(this.#view.value.draft.images.length === 0
              ? {}
              : { images: this.#view.value.draft.images }),
            ...credential,
            ...(this.#view.value.draft.model.trim().length === 0
              ? {}
              : { model: this.#view.value.draft.model.trim() }),
            prompt: this.#view.value.draft.prompt.trim(),
            ...(this.#view.value.draft.reasoningEffort.length === 0
              ? {}
              : {
                  reasoningEffort: this.#view.value.draft.reasoningEffort,
                }),
            runnerId: this.#view.value.draft.runnerId,
            tools: this.#view.value.draft.tools,
            workingDirectory: this.#view.value.draft.workingDirectory.trim(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      this.#view.patchCurrent(
        revision,
        sessionDetailState(this.#view.value, detail, {
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
      const detail = readSessionDetail(
        await requestJson(`${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`),
      );

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

  async #reassign(onlineRunnerIds: readonly string[]): Promise<void> {
    const detail = this.#view.value.detail;
    const sessionId = this.#view.value.selectedId;
    const input = this.#view.value.reassignment;
    if (
      sessionId === undefined ||
      detail?.id !== sessionId ||
      !detail.runnerRequired ||
      sessionDetailMutationPending(this.#view.value) ||
      !onlineRunnerIds.includes(input.runnerId) ||
      !hasTrimmedText(input.workingDirectory)
    ) {
      this.#view.patch({
        error:
          "Choose an online replacement runner and confirm a working directory on it.",
      });
      return;
    }
    await this.#mutateDetail({
      ...reassignSessionMutation(
        sessionId,
        input.runnerId,
        input.workingDirectory.trim(),
      ),
      success: { reassignment: emptySessionReassignmentDraft() },
    });
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
      reassignment: emptySessionReassignmentDraft(),
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
      detail.runnerRequired ||
      this.#detailMutationPending() ||
      (prompt.length === 0 && this.#view.value.followUpImages.length === 0)
    ) {
      return;
    }

    await this.#mutateDetail({
      action: "send that instruction",
      pending: "sending",
      request: () =>
        requestJson(
          `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/messages`,
          {
            body: JSON.stringify({
              ...(this.#view.value.followUpImages.length === 0
                ? {}
                : { images: this.#view.value.followUpImages }),
              prompt,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
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

  async #mutateRecoverable(
    mutation: (sessionId: string) => SessionMutation,
  ): Promise<void> {
    if (this.#view.value.detail?.runnerRequired !== true) {
      await this.#mutateWhen(sessionCanResume, mutation);
    }
  }

  async #compact(): Promise<void> {
    await this.#mutateRecoverable(compactSessionMutation);
  }

  async #toggleAutoCompact(autoCompact: boolean): Promise<void> {
    const sessionId = this.#view.value.selectedId;
    if (
      sessionId === undefined ||
      this.#view.value.detail?.runnerRequired === true ||
      this.#detailMutationPending() ||
      !selectedDetailHasStatus(this.#view.value, sessionCanResume)
    ) {
      return;
    }

    await this.#mutateDetail(compactionModeMutation(sessionId, autoCompact));
  }

  async #continue(): Promise<void> {
    await this.#mutateRecoverable(continueSessionMutation);
  }

  async #stop(): Promise<void> {
    await this.#mutateWhen(sessionIsActive, stopSessionMutation);
  }

  #detailMutationPending(): boolean {
    return sessionDetailMutationPending(this.#view.value);
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
      const detail = await executeSessionMutation(options);

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
    }
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
