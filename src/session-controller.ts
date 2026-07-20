import { HttpResponseError, requestJson } from "./browser-http.ts";
import { bindActionClicks } from "./client-actions.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import { RevisionState } from "./revision-state.ts";
import { SESSIONS_PATH } from "./routes.ts";
import type { SessionDraft, SessionViewState } from "./session-client.tsx";
import {
  readSessionDetail,
  readSessionList,
  summaryFromDetail,
} from "./session-codec.ts";
import type { AgentSessionDetail } from "./session-model.ts";

type ChangeListener = () => void;

function initialDraft(): SessionDraft {
  return {
    credential: "",
    model: "",
    prompt: "",
    runnerId: "",
    workingDirectory: ".",
  };
}

function initialState(): SessionViewState {
  return {
    creating: false,
    detail: undefined,
    draft: initialDraft(),
    error: undefined,
    followUp: "",
    loadingDetail: false,
    selectedId: undefined,
    sending: false,
    sessions: undefined,
    stopping: false,
  };
}

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
  onInput: (form: HTMLFormElement) => void,
  onSubmit: () => void,
): void {
  const form = panel.querySelector<HTMLFormElement>(
    `form[data-action="${action}"]`,
  );

  form?.addEventListener("input", () => {
    onInput(form);
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

export class SessionController {
  readonly #view: RevisionState<SessionViewState>;

  constructor(onChange: ChangeListener) {
    this.#view = new RevisionState(initialState(), onChange);
  }

  bind(container: Element): void {
    const panel = container.querySelector('[data-session-panel="true"]');

    if (panel === null) {
      return;
    }

    bindPanelForm(
      panel,
      "create-session",
      (form) => {
        this.#rememberDraft(form);
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

    bindActionClicks(panel, (control, action) => {
      if (action === "select-session") {
        const sessionId = control.dataset["sessionId"];

        if (sessionId !== undefined) {
          void this.#select(sessionId);
        }
      } else if (action === "stop-session") {
        void this.#stop();
      } else if (action === "retry-sessions") {
        void this.load();
      }
    });
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
    this.#view.reset(initialState());
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
      this.#view.patch({ selectedId, sessions });

      if (selectedId === undefined) {
        this.#view.patch({ detail: undefined });
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
      this.#view.value.draft.prompt.trim().length === 0 ||
      this.#view.value.draft.workingDirectory.trim().length === 0
    ) {
      this.#view.patch({
        error: "Choose a runner and credential, then describe the task.",
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
        this.#view.patchCurrent(
          revision,
          this.#detailState(detail, { loadingDetail: false }),
        );
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

  #rememberDraft(form: HTMLFormElement): void {
    this.#remember({
      draft: {
        credential: formString(form, "credential"),
        model: formString(form, "model"),
        prompt: formString(form, "prompt"),
        runnerId: formString(form, "runnerId"),
        workingDirectory: formString(form, "workingDirectory"),
      },
    });
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
