import { isRecord } from "../shared/auth-model.ts";
import { PROMPT_MAXIMUM_COUNT, type Prompt } from "../shared/prompt-model.ts";
import { readFiniteNumber } from "./codec.ts";

export function readPrompt(value: unknown): Prompt {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid prompt");
  }

  const result: Prompt = {
    body: String(value["body"]),
    createdAt: readFiniteNumber(value["createdAt"]) ?? Number.NaN,
    id: String(value["id"]),
    name: String(value["name"]),
    revision: readFiniteNumber(value["revision"]) ?? Number.NaN,
    updatedAt: readFiniteNumber(value["updatedAt"]) ?? Number.NaN,
  };
  if (
    typeof value["body"] !== "string" ||
    !Number.isFinite(result.createdAt) ||
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string" ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    !Number.isFinite(result.updatedAt)
  ) {
    throw new Error("The server returned an invalid prompt");
  }

  return result;
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
