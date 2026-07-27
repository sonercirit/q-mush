import {
  normalizePromptInput,
  type Prompt,
  type PromptInput,
} from "../shared/prompt-model.ts";
import { PROMPTS_PATH, promptPath } from "../shared/routes.ts";
import {
  hasHttpError,
  hasHttpStatus,
  request,
  requestJson,
} from "./browser-http.ts";
import { readPrompt, readPromptList } from "./prompt-codec.ts";
import { createPromptViewState, type PromptViewState } from "./prompt-state.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import { reactiveRevisionState, type RevisionState } from "./revision-state.ts";

const INVALID_INPUT_ERROR = "Enter a name and prompt body before saving.";
const CHANGED_ERROR =
  "That prompt changed in another window. Your draft was not saved.";

function writeError(error: unknown, fallback: string): string {
  if (hasHttpError(error, 409, "duplicate_name")) {
    return "A prompt with that name already exists.";
  }
  return fallback;
}

function versionHeaders(revision: number): Readonly<Record<string, string>> {
  return { "if-match": `"${String(revision)}"` };
}

interface PromptWrite {
  readonly error: string;
  readonly input: PromptInput;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly promptId?: string;
  readonly success: (prompt: Prompt) => Partial<PromptViewState>;
}

export class PromptController {
  readonly #view: RevisionState<PromptViewState>;

  constructor(
    view: ReactiveState<PromptViewState> = createReactiveState(
      createPromptViewState(undefined),
    ),
  ) {
    this.#view = reactiveRevisionState(view);
  }

  get state(): PromptViewState {
    return this.#view.value;
  }

  get view() {
    return this.#view.accessor;
  }

  #find(promptId: string | undefined): Prompt | undefined {
    return this.state.prompts?.find((prompt) => prompt.id === promptId);
  }

  #hasActiveSession(): boolean {
    return this.state.prompts !== undefined;
  }

  #withPrompt(promptId: string, use: (prompt: Prompt) => void): void {
    const prompt = this.#find(promptId);
    if (prompt !== undefined) {
      use(prompt);
    }
  }

  beginEdit(promptId: string): void {
    if (this.#isBusy()) {
      return;
    }
    this.#withPrompt(promptId, (prompt) => {
      this.#view.patch({
        confirmDeleteId: undefined,
        editDraft: { body: prompt.body, name: prompt.name },
        editingId: promptId,
        error: undefined,
      });
    });
  }

  cancelDelete(): void {
    this.#view.patch({ confirmDeleteId: undefined });
  }

  cancelEdit(): void {
    if (!this.state.saving) {
      this.#view.patch(this.#closedEditor());
    }
  }

  create(): Promise<void> {
    return this.#isBusy() || !this.#hasActiveSession()
      ? Promise.resolve()
      : this.#write({
          error: "We could not save that prompt. Please try again.",
          input: this.state.createDraft,
          method: "POST",
          path: PROMPTS_PATH,
          success: (prompt) => ({
            createDraft: { body: "", name: "" },
            prompts: [...(this.state.prompts ?? []), prompt],
          }),
        });
  }

  insertSelected(insert: (body: string) => boolean): boolean {
    const body = this.#find(this.state.selectedId)?.body;
    return body === undefined ? false : insert(body);
  }

  async load(): Promise<void> {
    if (!this.#isBusy()) {
      await this.#load(true);
    }
  }

  remove(promptId: string): Promise<void> {
    return this.#isBusy() ? Promise.resolve() : this.#remove(promptId);
  }

  requestDelete(promptId: string): void {
    if (!this.#isBusy() && this.#find(promptId) !== undefined) {
      this.#view.patch({ confirmDeleteId: promptId, error: undefined });
    }
  }

  reset(): void {
    this.#view.reset(createPromptViewState(undefined));
  }

  saveEdit(): Promise<void> {
    const promptId = this.state.editingId;
    if (this.#isBusy() || !this.#hasActiveSession() || promptId === undefined) {
      return Promise.resolve();
    }
    return this.#write({
      error: "We could not update that prompt. Please try again.",
      input: this.state.editDraft,
      method: "PUT",
      path: promptPath(promptId),
      promptId,
      success: (prompt) => ({
        ...this.#closedEditor(),
        prompts: this.state.prompts?.map((existing) =>
          existing.id === prompt.id ? prompt : existing,
        ),
      }),
    });
  }

  select(promptId: string): void {
    if (this.state.prompts?.some(({ id }) => id === promptId) === true) {
      this.#view.patch({ selectedId: promptId });
    }
  }

  #isBusy(): boolean {
    return (
      this.state.loading ||
      this.state.removingId !== undefined ||
      this.state.saving
    );
  }

  #settleAbandonedOperation(revision: number): void {
    this.#view.patchCurrent(revision, { saving: false });
  }

  #setDraftField(
    draft: "createDraft" | "editDraft",
    name: keyof PromptInput,
    value: string,
  ): void {
    this.#view.patch({ [draft]: { ...this.state[draft], [name]: value } });
  }

  setCreateField(name: keyof PromptInput, value: string): void {
    this.#setDraftField("createDraft", name, value);
  }

  setEditField(name: keyof PromptInput, value: string): void {
    this.#setDraftField("editDraft", name, value);
  }

  async #write(configuration: PromptWrite): Promise<void> {
    const input = normalizePromptInput(configuration.input);
    if (input === undefined) {
      this.#view.patch({ error: INVALID_INPUT_ERROR });
      return;
    }
    const stored = this.#find(configuration.promptId);
    if (configuration.promptId !== undefined && stored === undefined) {
      this.#view.patch({ error: CHANGED_ERROR });
      return;
    }

    const revision = this.#view.begin({ error: undefined, saving: true });
    const finish = (patch: Partial<PromptViewState>): void => {
      if (this.#view.isCurrent(revision)) {
        this.#view.patch({ ...patch, saving: false });
      } else {
        this.#settleAbandonedOperation(revision);
      }
    };
    try {
      const prompt = readPrompt(
        await requestJson(configuration.path, {
          body: JSON.stringify(input),
          headers:
            stored === undefined
              ? { "content-type": "application/json" }
              : {
                  "content-type": "application/json",
                  ...versionHeaders(stored.revision),
                },
          method: configuration.method,
        }),
      );
      finish(configuration.success(prompt));
    } catch (error) {
      if (
        hasHttpError(error, 409, "prompt_limit_reached") &&
        configuration.promptId === undefined
      ) {
        finish({
          error:
            "You have reached the limit of 100 saved prompts. Delete one before saving another.",
        });
        return;
      }
      if (hasHttpStatus(error, 412) && configuration.promptId !== undefined) {
        const draft = this.state.editDraft;
        const conflict = await this.#conflictPatch(revision);
        if (this.#view.isCurrent(revision)) {
          this.#view.patch({ editDraft: draft, ...conflict, saving: false });
        } else {
          this.#settleAbandonedOperation(revision);
        }
        return;
      }
      finish({ error: writeError(error, configuration.error) });
    }
  }

  async #conflictPatch(
    revision: number,
  ): Promise<Pick<PromptViewState, "error"> & Partial<PromptViewState>> {
    const prompts = await this.#load(false, revision);
    return {
      error: CHANGED_ERROR,
      ...(prompts === undefined ? {} : { prompts }),
    };
  }

  async #load(
    showLoading: boolean,
    activeRevision?: number,
  ): Promise<readonly Prompt[] | undefined> {
    const revision =
      activeRevision ??
      this.#view.begin({
        error: undefined,
        loading: true,
        ...(showLoading ? { prompts: undefined } : {}),
      });
    try {
      const prompts = readPromptList(await requestJson(PROMPTS_PATH));
      if (activeRevision === undefined) {
        this.#view.patchCurrent(revision, { loading: false, prompts });
      }
      return this.#view.isCurrent(revision) ? prompts : undefined;
    } catch {
      if (activeRevision === undefined) {
        this.#view.patchCurrent(revision, {
          error: "We could not load your prompts. Please try again.",
          loading: false,
        });
      }
      return undefined;
    }
  }

  async #remove(promptId: string): Promise<void> {
    const prompt = this.#find(promptId);
    if (prompt === undefined) {
      return;
    }
    const revision = this.#view.begin({
      confirmDeleteId: undefined,
      error: undefined,
      removingId: promptId,
    });
    try {
      await request(promptPath(promptId), {
        headers: versionHeaders(prompt.revision),
        method: "DELETE",
      });
      this.#view.patchCurrentWith(revision, () => ({
        ...(this.state.editingId === promptId ? this.#closedEditor() : {}),
        prompts: this.state.prompts?.filter(({ id }) => id !== promptId),
        removingId: undefined,
        selectedId:
          this.state.selectedId === promptId
            ? undefined
            : this.state.selectedId,
      }));
    } catch (error) {
      if (hasHttpStatus(error, 412)) {
        const conflict = await this.#conflictPatch(revision);
        this.#view.patchCurrent(revision, {
          ...conflict,
          removingId: undefined,
        });
        return;
      }
      this.#view.patchCurrent(revision, {
        error: "We could not delete that prompt. Please try again.",
        removingId: undefined,
      });
    }
  }

  #closedEditor(): Pick<PromptViewState, "editDraft" | "editingId"> {
    return { editDraft: { body: "", name: "" }, editingId: undefined };
  }
}
