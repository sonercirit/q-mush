export const PROMPT_NAME_MAXIMUM_LENGTH = 100;
export const PROMPT_BODY_MAXIMUM_LENGTH = 32_768;

export interface Prompt {
  readonly body: string;
  readonly createdAt: number;
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

export interface PromptInput {
  readonly body: string;
  readonly name: string;
}
