import { requestJson } from "./browser-http.ts";
import { bindActionClicks } from "./client-actions.ts";
import { customSelectValues } from "./custom-select-controller.ts";
import { DirectoryPickerController } from "./directory-picker-controller.ts";
import { RevisionState } from "./revision-state.ts";
import { SESSIONS_PATH } from "./routes.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";
import {
  replaceSessionSummary,
  selectedSessionCredential,
  sessionDataMatches,
  SessionRealtimeState,
} from "./session-controller-state.ts";
import { defaultedSessionDraft } from "./session-defaults.ts";
import {
  formString,
  readSessionDraft,
  selectedDraftOption,
} from "./session-form.ts";
import { bindSessionImageInputs } from "./session-image-bindings.ts";
import { appendAgentImageFiles } from "./session-image-input.ts";
import { SessionModelController } from "./session-model-controller.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "./session-model.ts";
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

type ChangeListener = () => void;

function selectedMutation(
  sessionId: string | undefined,
  create: (sessionId: string) => SessionMutation,
): SessionMutation | undefined {
  return sessionId === undefined ? undefined : create(sessionId);
}

function bindPanelForm(
  panel: Element,
  action: string,
  onInput: (form: HTMLFormElement, inputName?: string) => void,
  onSubmit: () => void,
): void {
  const form = panel.querySelector<HTMLFormElement>(
    `form[data-action="${action}"]`,
  );

  form?.addEventListener("input", (event) => {
    const inputName =
      event.target instanceof Element
        ? (event.target.getAttribute("name") ?? undefined)
        : undefined;
    onInput(form, inputName);
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    onInput(form);
    onSubmit();
  });
}

export class SessionController {
  readonly #directoryPicker: DirectoryPickerController;
  readonly #models: SessionModelController;
  readonly #realtime: SessionRealtimeState;
  readonly #view: RevisionState<SessionViewState>;

  constructor(onChange: ChangeListener) {
    this.#view = new RevisionState(initialSessionViewState(), onChange);
    this.#realtime = new SessionRealtimeState(this.#view);
    this.#models = new SessionModelController(this.#view);
    this.#directoryPicker = new DirectoryPickerController(() => {
      this.#view.patch({ directoryPicker: this.#directoryPicker.state });
    });
  }

  applyDetail(detail: AgentSessionDetail): void {
    if (
      this.#view.value.creating ||
      this.#view.value.compacting ||
      this.#view.value.sending ||
      this.#view.value.stopping
    ) {
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

  bind(container: Element): void {
    const panel = container.querySelector('[data-session-panel="true"]');

    if (panel === null) {
      return;
    }

    bindPanelForm(
      panel,
      "create-session",
      (form, inputName) => {
        this.#rememberDraft(form, inputName);
      },
      () => void this.#create(),
    );
    bindPanelForm(
      panel,
      "send-session-message",
      (form) => {
        this.#rememberFollowUp(form);
      },
      () => void this.#send(),
    );
    bindSessionImageInputs(panel, (files, follow) =>
      this.#addImages(files, follow),
    );

    bindActionClicks(panel, (control, action) => {
      if (action === "toggle-auto-compact") {
        void this.#toggleAutoCompact(control);
      } else if (action === "toggle-session-select") {
        const name = control.dataset["selectName"];

        if (
          name === "credential" ||
          name === "model" ||
          name === "reasoningEffort" ||
          name === "runnerId"
        ) {
          this.#view.patch({
            openSelect: this.#view.value.openSelect === name ? undefined : name,
          });
        }
      } else if (action === "choose-session-option") {
        const select = control.closest("[data-custom-select]");
        const name = control.dataset["selectName"];
        const value = control.dataset["optionValue"];
        if (
          select !== null &&
          name !== undefined &&
          value !== undefined &&
          select.getAttribute("data-custom-select") === name
        ) {
          const availableValues = customSelectValues(select);

          if (availableValues.includes(value)) {
            this.#rememberCreateForm(control);
            this.#chooseOption(name, value, availableValues);
          }
        }
      } else if (action === "remove-session-image") {
        this.#removeImage(control, "draft");
      } else if (action === "remove-follow-up-image") {
        this.#removeImage(control, "followUp");
      } else if (action === "select-session") {
        const sessionId = control.dataset["sessionId"];

        if (sessionId !== undefined) {
          void this.#select(sessionId);
        }
      } else if (action === "stop-session") {
        void this.#stop();
      } else if (action === "continue-session") {
        void this.#continue();
      } else if (action === "compact-session") {
        void this.#compact();
      } else if (action === "retry-sessions") {
        void this.load();
      } else if (action === "retry-models") {
        this.#models.ensure(this.#view.value.draft.credential, true);
      } else if (action === "open-directory-picker") {
        this.#rememberCreateForm(control);

        const draft = this.#view.value.draft;

        if (draft.runnerId.length > 0) {
          void this.#directoryPicker.open(
            draft.runnerId,
            draft.workingDirectory.trim() || "~",
          );
        }
      } else if (action === "browse-directory") {
        const path = control.dataset["directoryPath"];

        if (path !== undefined) {
          void this.#directoryPicker.browse(path);
        }
      } else if (action === "browse-parent-directory") {
        const parent = this.#directoryPicker.state.listing?.parent;

        if (parent !== null && parent !== undefined) {
          void this.#directoryPicker.browse(parent);
        }
      } else if (action === "browse-home-directory") {
        void this.#directoryPicker.browse("~");
      } else if (action === "retry-directory-picker") {
        void this.#directoryPicker.retry();
      } else if (action === "close-directory-picker") {
        this.#directoryPicker.close();
      } else if (action === "choose-directory") {
        const path = this.#directoryPicker.choose();

        if (path !== undefined) {
          const draft = { ...this.#view.value.draft, workingDirectory: path };
          this.#view.patch({ draft });
        }
      }
    });

    const directoryPicker = panel.querySelector<HTMLElement>(
      '[data-directory-picker="true"]',
    );
    directoryPicker?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#directoryPicker.close();
      }
    });

    if (
      directoryPicker !== null &&
      !directoryPicker.contains(panel.ownerDocument.activeElement)
    ) {
      directoryPicker.focus();
    }

    const defaultedDraft = defaultedSessionDraft(panel, this.#view.value.draft);

    if (defaultedDraft !== undefined) {
      this.#view.replaceSilently({
        ...this.#view.value,
        draft: defaultedDraft,
      });
    }

    if (defaultedDraft?.credential !== undefined) {
      this.#models.ensure(defaultedDraft.credential);
    }
  }

  get state(): SessionViewState {
    return this.#view.value;
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
    this.#directoryPicker.reset();
    this.#models.reset();
    this.#realtime.reset();
    this.#view.reset(initialSessionViewState());
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
        this.#view.patch({
          draft: {
            ...this.#view.value.draft,
            workingDirectory: mostRecentSessionDirectory(sessions),
          },
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
            workingDirectory: this.#view.value.draft.workingDirectory.trim(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
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

  #rememberCreateForm(control: Element): void {
    const form = control.closest<HTMLFormElement>(
      'form[data-action="create-session"]',
    );

    if (form !== null) {
      this.#rememberDraft(form);
    }
  }

  #chooseOption(
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

  #rememberDraft(form: HTMLFormElement, inputName?: string): void {
    const draft = readSessionDraft(form, this.#view.value.draft);

    if (inputName === "credential") {
      const nextDraft = { ...draft, model: "", reasoningEffort: "" };
      this.#view.patch({ draft: nextDraft });
      this.#models.ensure(nextDraft.credential);
    } else if (inputName === "model") {
      this.#view.patch({ draft: { ...draft, reasoningEffort: "" } });
    } else {
      this.#remember({ draft });
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

  #removeImage(control: HTMLElement, target: "draft" | "followUp"): void {
    const index = Number(control.dataset["imageIndex"]);
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

  #rememberFollowUp(form: HTMLFormElement): void {
    this.#remember({ followUp: formString(form, "prompt") });
  }

  #remember(patch: Partial<SessionViewState>): void {
    this.#view.replaceSilently({ ...this.#view.value, ...patch });
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
    const prompt = this.#view.value.followUp.trim();

    if (
      sessionId === undefined ||
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

  async #compact(): Promise<void> {
    await this.#mutateSelected(compactSessionMutation);
  }

  async #toggleAutoCompact(control: HTMLElement): Promise<void> {
    const autoCompact = control.dataset["autoCompact"];
    if (autoCompact !== "true" && autoCompact !== "false") {
      return;
    }

    const sessionId = this.#view.value.selectedId;
    if (sessionId === undefined) {
      return;
    }

    await this.#mutateDetail(
      compactionModeMutation(sessionId, autoCompact === "true"),
    );
  }

  async #continue(): Promise<void> {
    await this.#mutateSelected(continueSessionMutation);
  }

  async #stop(): Promise<void> {
    await this.#mutateSelected(stopSessionMutation);
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

      this.#view.patchCurrent(
        revision,
        this.#detailState(detail, { ...options.success, ...settled }),
      );
    } catch (error) {
      this.#patchMutationError(revision, error, options.action, settled);
    }
  }

  #detailState(
    detail: AgentSessionDetail,
    extra: Partial<SessionViewState>,
  ): Partial<SessionViewState> {
    return {
      detail,
      sessions: replaceSessionSummary(this.#view.value.sessions ?? [], detail),
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
