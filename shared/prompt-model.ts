export const PROMPT_NAME_MAXIMUM_LENGTH = 100;
export const PROMPT_BODY_MAXIMUM_LENGTH = 32_768;
export const PROMPT_MAXIMUM_COUNT = 100;

export interface Prompt {
  readonly body: string;
  readonly createdAt: number;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface PromptInput {
  readonly body: string;
  readonly name: string;
}

function normalizePromptName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizePromptInput(
  input: PromptInput,
): PromptInput | undefined {
  const name = normalizePromptName(input.name);
  if (
    input.body.length === 0 ||
    input.body.length > PROMPT_BODY_MAXIMUM_LENGTH ||
    input.body.trim().length === 0 ||
    input.name.length > PROMPT_NAME_MAXIMUM_LENGTH ||
    name.length === 0 ||
    name.length > PROMPT_NAME_MAXIMUM_LENGTH
  ) {
    return undefined;
  }
  return { body: input.body, name };
}

export function promptNameKey(name: string): string {
  return normalizePromptName(name).toLocaleLowerCase("en-US");
}
