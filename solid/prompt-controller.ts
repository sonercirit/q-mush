import type { Prompt, PromptInput } from "../shared/prompt-model.ts";
import { PROMPTS_PATH, promptPath } from "../shared/routes.ts";
import { hasHttpStatus, request, requestJson } from "./browser-http.ts";
import { readPrompt, readPromptList } from "./prompt-codec.ts";
import { createPromptViewState, type PromptViewState } from "./prompt-state.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import { RevisionState } from "./revision-state.ts";

const INVALID_INPUT_ERROR = "Enter a name and prompt body before saving.";

function normalizedInput(input: PromptInput): PromptInput | undefined {
  const normalized = { body: input.body.trim(), name: input.name.trim() };
  return normalized.name.length === 0 || normalized.body.length === 0
    ? undefined
    : normalized;
}

function writeError(error: unknown, fallback: string): string {
  return hasHttpStatus(error, 409)
    ? "A prompt with that name already exists."
    : fallback;
}

interface PromptWrite {
  readonly error: string;
  readonly input: PromptInput;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly success: (prompt: Prompt) => Partial<PromptViewState>;
}

export class PromptController {
  readonly #view: RevisionState<PromptViewState>;

  constructor(
    view: ReactiveState<PromptViewState> = createReactiveState(
      createPromptViewState(undefined),
    ),
  ) {
    this.#view = RevisionState.fromReactive(view);
  }

  get state(): PromptViewState {
    return this.#view.value;
  }

  get view() {
    return this.#view.accessor;
  }

  #find(promptId: string | undefined): Prompt | undefined {
    return promptId === undefined
      ? undefined
      : this.state.prompts?.find(({ id }) => id === promptId);
  }

  beginEdit(promptId: string): void {
    const prompt = this.#find(promptId);
    if (prompt === undefined) {
      return;
    }
    this.#view.patch({
      editDraft: { body: prompt.body, name: prompt.name },
      editingId: promptId,
      error: undefined,
    });
  }

  cancelEdit(): void {
    this.#view.patch(this.#closedEditor());
  }

  create(): Promise<void> {
    return this.#write({
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

  insertSelected(insert: (body: string) => void): void {
    const body = this.#find(this.state.selectedId)?.body;
    if (body !== undefined) {
      insert(body);
    }
  }

  load(): Promise<void> {
    return this.#load();
  }

  remove(promptId: string): Promise<void> {
    return this.#remove(promptId);
  }

  reset(): void {
    this.#view.reset(createPromptViewState(undefined));
  }

  saveEdit(): Promise<void> {
    const promptId = this.state.editingId;
    return promptId === undefined
      ? Promise.resolve()
      : this.#write({
          error: "We could not update that prompt. Please try again.",
          input: this.state.editDraft,
          method: "PUT",
          path: promptPath(promptId),
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

  #setDraftField(
    draft: "createDraft" | "editDraft",
    name: keyof PromptInput,
    value: string,
  ): void {
    const input = { ...this.state[draft], [name]: value };
    this.#view.patch({ [draft]: input });
  }

  setCreateField(name: keyof PromptInput, value: string): void {
    this.#setDraftField("createDraft", name, value);
  }

  setEditField(name: keyof PromptInput, value: string): void {
    this.#setDraftField("editDraft", name, value);
  }

  async #write(configuration: PromptWrite): Promise<void> {
    const input = normalizedInput(configuration.input);
    if (input === undefined) {
      this.#view.patch({ error: INVALID_INPUT_ERROR });
      return;
    }

    const revision = this.#view.begin({ error: undefined, saving: true });
    const finish = (patch: Partial<PromptViewState>): void => {
      this.#view.patchCurrent(revision, { ...patch, saving: false });
    };
    try {
      const prompt = readPrompt(
        await requestJson(configuration.path, {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: configuration.method,
        }),
      );
      finish(configuration.success(prompt));
    } catch (error) {
      finish({ error: writeError(error, configuration.error) });
    }
  }

  #beginRequest(patch: Partial<PromptViewState>): number {
    const revision = this.#view.begin();
    this.#view.patch({ error: undefined, ...patch });
    return revision;
  }

  async #load(): Promise<void> {
    const revision = this.#beginRequest({ prompts: undefined });
    try {
      const prompts = readPromptList(await requestJson(PROMPTS_PATH));
      this.#view.patchCurrent(revision, { prompts });
    } catch {
      this.#view.patchCurrent(revision, {
        error: "We could not load your prompts. Please try again.",
      });
    }
  }

  async #remove(promptId: string): Promise<void> {
    const revision = this.#beginRequest({ removingId: promptId });
    try {
      await request(promptPath(promptId), { method: "DELETE" });
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
      const message = "We could not delete that prompt. Please try again.";
      this.#view.patchCurrent(revision, {
        error: writeError(error, message),
        removingId: undefined,
      });
    }
  }

  #closedEditor(): Pick<PromptViewState, "editDraft" | "editingId"> {
    return { editDraft: { body: "", name: "" }, editingId: undefined };
  }
}
