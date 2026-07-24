/* jscpd:ignore-start */
import { isRecord } from "./auth-model.ts";

const MAXIMUM_ASK_QUESTIONS = 8;
const MAXIMUM_QUESTION_OPTIONS = 12;
const MAXIMUM_QUESTION_PROMPT_LENGTH = 1_000;
const MAXIMUM_QUESTION_TEXT_LENGTH = 4_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

interface AskQuestionOption {
  readonly label: string;
  readonly value: string;
}

interface AskQuestionBase {
  readonly id: string;
  readonly prompt: string;
}

interface FreeTextQuestion extends AskQuestionBase {
  readonly maxLength: number;
  readonly minLength?: number;
  readonly type: "free_text";
}

interface SingleChoiceQuestion extends AskQuestionBase {
  readonly options: readonly AskQuestionOption[];
  readonly type: "single_choice";
}

interface MultiChoiceQuestion extends AskQuestionBase {
  readonly maxSelections?: number;
  readonly minSelections?: number;
  readonly options: readonly AskQuestionOption[];
  readonly type: "multi_choice";
}

export type AskQuestion =
  FreeTextQuestion | MultiChoiceQuestion | SingleChoiceQuestion;

export interface AskQuestionsInput {
  readonly questions: readonly AskQuestion[];
}

export interface AskQuestionAnswer {
  readonly questionId: string;
  readonly value: readonly string[] | string;
}

export interface AskQuestionAnswers {
  readonly answers: readonly AskQuestionAnswer[];
}

export interface PendingAskQuestions extends AskQuestionsInput {
  readonly createdAt: number;
  readonly id: string;
  readonly toolCallId: string;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum
    ? normalized
    : undefined;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function nonnegativeInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readOptions(value: unknown): readonly AskQuestionOption[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > MAXIMUM_QUESTION_OPTIONS
  ) {
    return undefined;
  }

  const options: AskQuestionOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      return undefined;
    }
    const label = boundedString(candidate["label"], 200);
    const optionValue = boundedString(candidate["value"], 200);
    if (
      !hasOnlyKeys(candidate, ["label", "value"]) ||
      label === undefined ||
      optionValue === undefined ||
      options.some(({ value: existing }) => existing === optionValue)
    ) {
      return undefined;
    }
    options.push({ label, value: optionValue });
  }
  return options;
}

function readQuestion(value: unknown): AskQuestion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = boundedString(value["id"], 64);
  const prompt = boundedString(value["prompt"], MAXIMUM_QUESTION_PROMPT_LENGTH);
  if (id === undefined || !ID_PATTERN.test(id) || prompt === undefined) {
    return undefined;
  }

  switch (value["type"]) {
    case "free_text": {
      const maxLength = positiveInteger(
        value["maxLength"],
        MAXIMUM_QUESTION_TEXT_LENGTH,
      );
      const minLength =
        value["minLength"] === undefined
          ? undefined
          : nonnegativeInteger(
              value["minLength"],
              MAXIMUM_QUESTION_TEXT_LENGTH,
            );
      return maxLength === undefined ||
        !hasOnlyKeys(value, [
          "id",
          "maxLength",
          "minLength",
          "prompt",
          "type",
        ]) ||
        (minLength === undefined && value["minLength"] !== undefined) ||
        (minLength ?? 0) > maxLength
        ? undefined
        : {
            id,
            maxLength,
            ...(minLength === undefined ? {} : { minLength }),
            prompt,
            type: "free_text",
          };
    }
    case "single_choice": {
      const options = readOptions(value["options"]);
      return options === undefined ||
        !hasOnlyKeys(value, ["id", "options", "prompt", "type"])
        ? undefined
        : { id, options, prompt, type: "single_choice" };
    }
    case "multi_choice": {
      const options = readOptions(value["options"]);
      if (options === undefined) {
        return undefined;
      }
      const maximum = options.length;
      const maxSelections =
        value["maxSelections"] === undefined
          ? undefined
          : positiveInteger(value["maxSelections"], maximum);
      const minSelections =
        value["minSelections"] === undefined
          ? undefined
          : nonnegativeInteger(value["minSelections"], maximum);
      if (
        !hasOnlyKeys(value, [
          "id",
          "maxSelections",
          "minSelections",
          "options",
          "prompt",
          "type",
        ]) ||
        (value["maxSelections"] !== undefined && maxSelections === undefined) ||
        (value["minSelections"] !== undefined && minSelections === undefined) ||
        (minSelections ?? 0) > (maxSelections ?? maximum)
      ) {
        return undefined;
      }
      return {
        id,
        ...(maxSelections === undefined ? {} : { maxSelections }),
        ...(minSelections === undefined ? {} : { minSelections }),
        options,
        prompt,
        type: "multi_choice",
      };
    }
    default:
      return undefined;
  }
}

export function readAskQuestionsInput(
  value: unknown,
): AskQuestionsInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawQuestions = value["questions"];
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    rawQuestions.length > MAXIMUM_ASK_QUESTIONS
  ) {
    return undefined;
  }
  const questions: AskQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    const question = readQuestion(rawQuestion);
    if (
      question === undefined ||
      questions.some(({ id }) => id === question.id)
    ) {
      return undefined;
    }
    questions.push(question);
  }
  return Object.keys(value).length === 1 ? { questions } : undefined;
}

function selectedValues(
  value: unknown,
  question: MultiChoiceQuestion,
): readonly string[] | undefined {
  const values: string[] = [];
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    values.push(item);
  }
  const minimum = question.minSelections ?? 0;
  const maximum = question.maxSelections ?? question.options.length;
  return values.length < minimum ||
    values.length > maximum ||
    new Set(values).size !== values.length ||
    values.some(
      (selected) =>
        !question.options.some(({ value: option }) => option === selected),
    )
    ? undefined
    : values;
}

function answerValue(
  value: unknown,
  question: AskQuestion,
): readonly string[] | string | undefined {
  switch (question.type) {
    case "free_text": {
      if (typeof value !== "string") {
        return undefined;
      }
      const normalized = value.trim();
      return normalized.length < (question.minLength ?? 0) ||
        normalized.length > question.maxLength
        ? undefined
        : normalized;
    }
    case "single_choice":
      return typeof value === "string" &&
        question.options.some(({ value: option }) => option === value)
        ? value
        : undefined;
    case "multi_choice":
      return selectedValues(value, question);
  }
}

export function readAskQuestionAnswers(
  value: unknown,
  questions: readonly AskQuestion[],
): AskQuestionAnswers | undefined {
  if (!isRecord(value) || !Array.isArray(value["answers"])) {
    return undefined;
  }
  const rawAnswers: readonly unknown[] = value["answers"];
  if (rawAnswers.length !== questions.length) {
    return undefined;
  }
  const answers: AskQuestionAnswer[] = [];
  for (const question of questions) {
    let candidate: Readonly<Record<string, unknown>> | undefined;
    for (const rawAnswer of rawAnswers) {
      if (isRecord(rawAnswer) && rawAnswer["questionId"] === question.id) {
        if (candidate !== undefined) {
          return undefined;
        }
        candidate = rawAnswer;
      }
    }
    if (
      candidate === undefined ||
      Object.keys(candidate).some(
        (key) => key !== "questionId" && key !== "value",
      )
    ) {
      return undefined;
    }
    const answer = answerValue(candidate["value"], question);
    if (answer === undefined) {
      return undefined;
    }
    answers.push({ questionId: question.id, value: answer });
  }
  return Object.keys(value).length === 1 ? { answers } : undefined;
}

export function canonicalAskQuestionsResult(
  answers: AskQuestionAnswers,
): string {
  return JSON.stringify(answers, null, 2);
}
/* jscpd:ignore-end */
