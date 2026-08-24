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

export interface PromptController {
  readonly beginEdit: (promptId: string) => void;
  readonly cancelDelete: () => void;
  readonly cancelEdit: () => void;
  readonly create: () => Promise<void>;
  readonly insertSelected: (insert: (body: string) => boolean) => boolean;
  readonly load: () => Promise<void>;
  readonly remove: (promptId: string) => Promise<void>;
  readonly requestDelete: (promptId: string) => void;
  readonly reset: () => void;
  readonly saveEdit: () => Promise<void>;
  readonly select: (promptId: string) => void;
  readonly setCreateField: (name: keyof PromptInput, value: string) => void;
  readonly setEditField: (name: keyof PromptInput, value: string) => void;
  readonly state: PromptViewState;
  readonly view: RevisionState<PromptViewState>["accessor"];
}

export function createPromptController(
  reactive: ReactiveState<PromptViewState> = createReactiveState(
    createPromptViewState(undefined),
  ),
): PromptController {
  const viewState = reactiveRevisionState(reactive);
  const state = (): PromptViewState => viewState.value;

  function find(promptId: string | undefined): Prompt | undefined {
    return state().prompts?.find((prompt) => prompt.id === promptId);
  }

  function hasActiveSession(): boolean {
    return state().prompts !== undefined;
  }

  function withPrompt(promptId: string, use: (prompt: Prompt) => void): void {
    const prompt = find(promptId);
    if (prompt !== undefined) {
      use(prompt);
    }
  }

  function beginEdit(promptId: string): void {
    if (isBusy()) {
      return;
    }
    withPrompt(promptId, (prompt) => {
      viewState.patch({
        confirmDeleteId: undefined,
        editDraft: { body: prompt.body, name: prompt.name },
        editingId: promptId,
        error: undefined,
      });
    });
  }

  function cancelDelete(): void {
    viewState.patch({ confirmDeleteId: undefined });
  }

  function cancelEdit(): void {
    if (!state().saving) {
      viewState.patch(closedEditor());
    }
  }

  function create(): Promise<void> {
    return isBusy() || !hasActiveSession()
      ? Promise.resolve()
      : write({
          error: "We could not save that prompt. Please try again.",
          input: state().createDraft,
          method: "POST",
          path: PROMPTS_PATH,
          success: (prompt) => ({
            createDraft: { body: "", name: "" },
            prompts: [...(state().prompts ?? []), prompt],
          }),
        });
  }

  function insertSelected(insert: (body: string) => boolean): boolean {
    const body = find(state().selectedId)?.body;
    return body === undefined ? false : insert(body);
  }

  async function load(): Promise<void> {
    if (!isBusy()) {
      await loadPrompts(true);
    }
  }

  function remove(promptId: string): Promise<void> {
    return isBusy() ? Promise.resolve() : removePrompt(promptId);
  }

  function requestDelete(promptId: string): void {
    if (!isBusy() && find(promptId) !== undefined) {
      viewState.patch({ confirmDeleteId: promptId, error: undefined });
    }
  }

  function reset(): void {
    viewState.reset(createPromptViewState(undefined));
  }

  function saveEdit(): Promise<void> {
    const promptId = state().editingId;
    if (isBusy() || !hasActiveSession() || promptId === undefined) {
      return Promise.resolve();
    }
    return write({
      error: "We could not update that prompt. Please try again.",
      input: state().editDraft,
      method: "PUT",
      path: promptPath(promptId),
      promptId,
      success: (prompt) => ({
        ...closedEditor(),
        prompts: state().prompts?.map((existing) =>
          existing.id === prompt.id ? prompt : existing,
        ),
      }),
    });
  }

  function select(promptId: string): void {
    if (state().prompts?.some(({ id }) => id === promptId) === true) {
      viewState.patch({ selectedId: promptId });
    }
  }

  function isBusy(): boolean {
    return (
      state().loading ||
      state().removingId !== undefined ||
      state().saving
    );
  }

  function settleAbandonedOperation(revision: number): void {
    viewState.patchCurrent(revision, { saving: false });
  }

  function setDraftField(
    draft: "createDraft" | "editDraft",
    name: keyof PromptInput,
    value: string,
  ): void {
    viewState.patch({ [draft]: { ...state()[draft], [name]: value } });
  }

  function setCreateField(name: keyof PromptInput, value: string): void {
    setDraftField("createDraft", name, value);
  }

  function setEditField(name: keyof PromptInput, value: string): void {
    setDraftField("editDraft", name, value);
  }

  async function write(configuration: PromptWrite): Promise<void> {
    const input = normalizePromptInput(configuration.input);
    if (input === undefined) {
      viewState.patch({ error: INVALID_INPUT_ERROR });
      return;
    }
    const stored = find(configuration.promptId);
    if (configuration.promptId !== undefined && stored === undefined) {
      viewState.patch({ error: CHANGED_ERROR });
      return;
    }

    const revision = viewState.begin({ error: undefined, saving: true });
    const finish = (patch: Partial<PromptViewState>): void => {
      if (viewState.isCurrent(revision)) {
        viewState.patch({ ...patch, saving: false });
      } else {
        settleAbandonedOperation(revision);
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
        const draft = state().editDraft;
        const conflict = await conflictPatch(revision);
        if (viewState.isCurrent(revision)) {
          viewState.patch({ editDraft: draft, ...conflict, saving: false });
        } else {
          settleAbandonedOperation(revision);
        }
        return;
      }
      finish({ error: writeError(error, configuration.error) });
    }
  }

  async function conflictPatch(
    revision: number,
  ): Promise<Pick<PromptViewState, "error"> & Partial<PromptViewState>> {
    const prompts = await loadPrompts(false, revision);
    return {
      error: CHANGED_ERROR,
      ...(prompts === undefined ? {} : { prompts }),
    };
  }

  async function loadPrompts(
    showLoading: boolean,
    activeRevision?: number,
  ): Promise<readonly Prompt[] | undefined> {
    const revision =
      activeRevision ??
      viewState.begin({
        error: undefined,
        loading: true,
        ...(showLoading ? { prompts: undefined } : {}),
      });
    try {
      const prompts = readPromptList(await requestJson(PROMPTS_PATH));
      if (activeRevision === undefined) {
        viewState.patchCurrent(revision, { loading: false, prompts });
      }
      return viewState.isCurrent(revision) ? prompts : undefined;
    } catch {
      if (activeRevision === undefined) {
        viewState.patchCurrent(revision, {
          error: "We could not load your prompts. Please try again.",
          loading: false,
        });
      }
      return undefined;
    }
  }

  async function removePrompt(promptId: string): Promise<void> {
    const prompt = find(promptId);
    if (prompt === undefined) {
      return;
    }
    const revision = viewState.begin({
      confirmDeleteId: undefined,
      error: undefined,
      removingId: promptId,
    });
    try {
      await request(promptPath(promptId), {
        headers: versionHeaders(prompt.revision),
        method: "DELETE",
      });
      viewState.patchCurrentWith(revision, () => ({
        ...(state().editingId === promptId ? closedEditor() : {}),
        prompts: state().prompts?.filter(({ id }) => id !== promptId),
        removingId: undefined,
        selectedId:
          state().selectedId === promptId
            ? undefined
            : state().selectedId,
      }));
    } catch (error) {
      if (hasHttpStatus(error, 412)) {
        const conflict = await conflictPatch(revision);
        viewState.patchCurrent(revision, {
          ...conflict,
          removingId: undefined,
        });
        return;
      }
      viewState.patchCurrent(revision, {
        error: "We could not delete that prompt. Please try again.",
        removingId: undefined,
      });
    }
  }

  function closedEditor(): Pick<PromptViewState, "editDraft" | "editingId"> {
    return { editDraft: { body: "", name: "" }, editingId: undefined };
  }

  return {
    beginEdit,
    cancelDelete,
    cancelEdit,
    create,
    insertSelected,
    load,
    remove,
    requestDelete,
    reset,
    saveEdit,
    select,
    setCreateField,
    setEditField,
    get state() { return state(); },
    view: viewState.accessor,
  };
}
