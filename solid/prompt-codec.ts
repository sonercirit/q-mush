import { isRecord } from "../shared/auth-model.ts";
import { PROMPT_MAXIMUM_COUNT, type Prompt } from "../shared/prompt-model.ts";
import { readFiniteNumber } from "../shared/validation.ts";

export function readPrompt(value: unknown): Prompt {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid prompt");
  }
  const createdAt = readFiniteNumber(value["createdAt"]);
  const revision = readFiniteNumber(value["revision"]);
  const updatedAt = readFiniteNumber(value["updatedAt"]);
  if (
    typeof value["body"] !== "string" ||
    createdAt === undefined ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string" ||
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    updatedAt === undefined
  ) {
    throw new Error("The server returned an invalid prompt");
  }
  return {
    body: value["body"],
    createdAt,
    id: value["id"],
    name: value["name"],
    revision,
    updatedAt,
  };
}

export function readPromptList(value: unknown): readonly Prompt[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value["prompts"]) ||
    value["prompts"].length > PROMPT_MAXIMUM_COUNT
  ) {
    throw new Error("The server returned an invalid prompt list");
  }
  return value["prompts"].map(readPrompt);
}
