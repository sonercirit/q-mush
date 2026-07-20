import type { AgentModelCatalog } from "./agent-configuration.ts";
import { HttpResponseError, requestJson } from "./browser-http.ts";
import {
  bindActionClicks,
  submitFormOnControlEnter,
} from "./client-actions.ts";
import { customSelectValues } from "./custom-select-controller.ts";
import { DirectoryPickerController } from "./directory-picker-controller.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import { RevisionState } from "./revision-state.ts";
import { SESSION_MODELS_PATH, SESSIONS_PATH } from "./routes.ts";
import type { SessionDraft, SessionViewState } from "./session-client.tsx";
import {
  readAgentModelCatalog,
  readSessionDetail,
  readSessionList,
  summaryFromDetail,
} from "./session-codec.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "./session-model.ts";
import {
  applySessionModelCatalog,
  chooseSessionOption,
} from "./session-selection.ts";
import {
  initialSessionViewState,
  sessionModelDiscoveryState,
} from "./session-state.ts";

type ChangeListener = () => void;

function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

function selectedCredential(value: string):
  | {
      readonly credentialId: string;
      readonly provider: ProviderId;
    }
  | undefined {
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const credentialId = value.slice(separator + 1);

  if (
    separator < 1 ||
    (provider !== "openai" && provider !== "openrouter") ||
    credentialId.length === 0
  ) {
    return undefined;
  }

  return { credentialId, provider };
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

function replaceSummary(
  sessions: readonly ReturnType<typeof summaryFromDetail>[],
  detail: AgentSessionDetail,
): readonly ReturnType<typeof summaryFromDetail>[] {
  const summary = summaryFromDetail(detail);
  return [summary, ...sessions.filter(({ id }) => id !== summary.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

function sessionDataMatches(
  left: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
  right: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SessionController {
  readonly #directoryPicker: DirectoryPickerController;
  readonly #modelCatalogs = new Map<string, AgentModelCatalog>();
  #modelRequest = 0;
  readonly #view: RevisionState<SessionViewState>;

  constructor(onChange: ChangeListener) {
    this.#view = new RevisionState(initialSessionViewState(), onChange);
    this.#directoryPicker = new DirectoryPickerController(() => {
      this.#view.patch({ directoryPicker: this.#directoryPicker.state });
    });
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
      () => {
        void this.#create();
      },
    );
    bindPanelForm(
      panel,
      "send-session-message",
      (form) => {
        this.#rememberFollowUp(form);
      },
      () => {
        void this.#send();
      },
    );
    for (const textarea of panel.querySelectorAll<HTMLTextAreaElement>(
      'textarea[name="prompt"]',
    )) {
      textarea.addEventListener("keydown", (event) => {
        const form = textarea.form;

        if (form !== null) {
          submitFormOnControlEnter(event, form);
        }
      });
    }

    bindActionClicks(panel, (control, action) => {
      if (action === "toggle-session-select") {
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
      } else if (action === "select-session") {
        const sessionId = control.dataset["sessionId"];

        if (sessionId !== undefined) {
          void this.#select(sessionId);
        }
      } else if (action === "stop-session") {
        void this.#stop();
      } else if (action === "retry-sessions") {
        void this.load();
      } else if (action === "retry-models") {
        void this.#ensureModels(this.#view.value.draft.credential, true);
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
          this.#view.patch({
            draft: { ...this.#view.value.draft, workingDirectory: path },
          });
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

    const credential = panel.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="credential"]',
    )?.value;

    if (credential !== undefined && credential.length > 0) {
      void this.#ensureModels(credential);
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

  async refresh(): Promise<void> {
    if (
      this.#view.value.sessions === undefined ||
      this.#view.value.creating ||
      this.#view.value.sending ||
      this.#view.value.stopping
    ) {
      return;
    }

    await this.#loadSessions(this.#view.begin(), false);
  }

  reset(): void {
    this.#directoryPicker.reset();
    this.#modelCatalogs.clear();
    this.#modelRequest += 1;
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
        this.#view.patch({ selectedId, sessions });
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
    const credential = selectedCredential(this.#view.value.draft.credential);

    if (
      credential === undefined ||
      this.#view.value.draft.runnerId.length === 0 ||
      this.#view.value.draft.model.length === 0 ||
      this.#view.value.draft.prompt.trim().length === 0 ||
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
          draft: { ...this.#view.value.draft, prompt: "" },
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
    const draft = chooseSessionOption(
      panel,
      {
        availableValues,
        models: panel.modelDiscovery.catalog,
      },
      name,
      value,
    );

    if (draft === undefined) {
      return;
    }

    this.#view.patch({ draft, openSelect: undefined });

    if (name === "credential") {
      void this.#ensureModels(value);
    }
  }

  #rememberDraft(form: HTMLFormElement, inputName?: string): void {
    const draft: SessionDraft = {
      credential: formString(form, "credential"),
      model: formString(form, "model"),
      prompt: formString(form, "prompt"),
      reasoningEffort: formString(form, "reasoningEffort"),
      runnerId: formString(form, "runnerId"),
      workingDirectory: formString(form, "workingDirectory"),
    };

    if (inputName === "credential") {
      const nextDraft = { ...draft, model: "", reasoningEffort: "" };
      this.#view.patch({ draft: nextDraft });
      void this.#ensureModels(nextDraft.credential);
    } else if (inputName === "model") {
      this.#view.patch({ draft: { ...draft, reasoningEffort: "" } });
    } else {
      this.#remember({ draft });
    }
  }

  #applyModelCatalog(credential: string, catalog: AgentModelCatalog): void {
    this.#view.patch({
      draft: applySessionModelCatalog(
        this.#view.value.draft,
        credential,
        catalog,
      ),
      modelDiscovery: sessionModelDiscoveryState(credential, false, catalog),
      openSelect: undefined,
    });
  }

  async #ensureModels(credentialValue: string, force = false): Promise<void> {
    const credential = selectedCredential(credentialValue);

    if (credential === undefined) {
      return;
    }

    if (this.#view.value.draft.credential !== credentialValue) {
      this.#remember({
        draft: {
          ...this.#view.value.draft,
          credential: credentialValue,
          model: "",
          reasoningEffort: "",
        },
      });
    }

    const discovery = this.#view.value.modelDiscovery;

    if (
      !force &&
      discovery.credential === credentialValue &&
      (discovery.loading || discovery.catalog !== undefined)
    ) {
      return;
    }

    const cached = force ? undefined : this.#modelCatalogs.get(credentialValue);

    if (cached !== undefined) {
      this.#applyModelCatalog(credentialValue, cached);
      return;
    }

    const request = (this.#modelRequest += 1);
    this.#view.patch({
      modelDiscovery: sessionModelDiscoveryState(credentialValue, true),
    });

    try {
      const search = new URLSearchParams(credential);
      const catalog = readAgentModelCatalog(
        await requestJson(`${SESSION_MODELS_PATH}?${search.toString()}`),
      );

      if (
        request !== this.#modelRequest ||
        this.#view.value.draft.credential !== credentialValue
      ) {
        return;
      }

      this.#modelCatalogs.set(credentialValue, catalog);
      this.#applyModelCatalog(credentialValue, catalog);
    } catch {
      if (
        request === this.#modelRequest &&
        this.#view.value.draft.credential === credentialValue
      ) {
        this.#view.patch({
          modelDiscovery: sessionModelDiscoveryState(
            credentialValue,
            false,
            undefined,
            "Model discovery failed",
          ),
        });
      }
    }
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
      loadingDetail: true,
      selectedId: sessionId,
    });
    await this.#readDetail(sessionId, revision, true);
  }

  async #send(): Promise<void> {
    const sessionId = this.#view.value.selectedId;
    const prompt = this.#view.value.followUp.trim();

    if (sessionId === undefined || prompt.length === 0) {
      return;
    }

    await this.#mutateDetail({
      action: "send that instruction",
      pending: "sending",
      request: () =>
        requestJson(
          `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/messages`,
          {
            body: JSON.stringify({ prompt }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      success: { followUp: "" },
    });
  }

  async #stop(): Promise<void> {
    const sessionId = this.#view.value.selectedId;

    if (sessionId !== undefined) {
      await this.#mutateDetail({
        action: "stop that session",
        pending: "stopping",
        request: () =>
          requestJson(
            `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/stop`,
            { method: "POST" },
          ),
      });
    }
  }

  async #mutateDetail(options: {
    readonly action: string;
    readonly pending: "sending" | "stopping";
    readonly request: () => Promise<unknown>;
    readonly success?: Partial<SessionViewState>;
  }): Promise<void> {
    const pending =
      options.pending === "sending" ? { sending: true } : { stopping: true };
    const settled =
      options.pending === "sending" ? { sending: false } : { stopping: false };
    const revision = this.#view.begin({ error: undefined, ...pending });

    try {
      const detail = readSessionDetail(await options.request());

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
      sessions: replaceSummary(this.#view.value.sessions ?? [], detail),
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
      error: this.#mutationError(error, action),
    });
  }

  #mutationError(error: unknown, action: string): string {
    if (error instanceof HttpResponseError && error.status === 409) {
      return "The selected runner or credential is unavailable, or the session is busy.";
    }

    return `We could not ${action}. Please try again.`;
  }
}
