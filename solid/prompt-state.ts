import type { Accessor } from "solid-js";
import type { Prompt, PromptInput } from "../shared/prompt-model.ts";

export interface PromptViewState {
  readonly createDraft: PromptInput;
  readonly editDraft: PromptInput;
  readonly editingId: string | undefined;
  readonly error: string | undefined;
  readonly prompts: readonly Prompt[] | undefined;
  readonly removingId: string | undefined;
  readonly saving: boolean;
  readonly selectedId: string | undefined;
}

export function createPromptViewState(
  prompts: readonly Prompt[] | undefined,
): PromptViewState {
  return {
    createDraft: { body: "", name: "" },
    editDraft: { body: "", name: "" },
    editingId: undefined,
    error: undefined,
    prompts,
    removingId: undefined,
    saving: false,
    selectedId: undefined,
  };
}

export interface PromptBankController {
  readonly view: Accessor<PromptViewState>;
  beginEdit(promptId: string): void;
  cancelEdit(): void;
  create(): Promise<void>;
  insertSelected(insert: (body: string) => void): void;
  load(): Promise<void>;
  remove(promptId: string): Promise<void>;
  saveEdit(): Promise<void>;
  select(promptId: string): void;
  setCreateField(name: keyof PromptInput, value: string): void;
  setEditField(name: keyof PromptInput, value: string): void;
}
