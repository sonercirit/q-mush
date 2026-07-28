import { isRecord } from "./auth-model.ts";
import {
  hasOnlyKeys,
  readBoundedTrimmedString,
  stringArray,
} from "./validation.ts";

export const ANSWER_QUESTIONS_REALTIME_OPERATION =
  "sessions.answer_questions" as const;
const MAXIMUM_ASK_QUESTIONS = 8;
const MAXIMUM_QUESTION_OPTIONS = 12;
const MAXIMUM_QUESTION_PROMPT_LENGTH = 1_000;
export const MAXIMUM_QUESTION_TEXT_LENGTH = 4_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const COMMAND_ID_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;

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
  readonly executionGeneration: number;
  readonly id: string;
  readonly toolCallId: string;
}

export interface AnswerQuestionsRealtimePayload extends AskQuestionAnswers {
  readonly requestId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
    ? Number(value)
    : undefined;
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
    const label = readBoundedTrimmedString(candidate["label"], 200);
    const optionValue = readBoundedTrimmedString(candidate["value"], 200);
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
  const id = readBoundedTrimmedString(value["id"], 64);
  const prompt = readBoundedTrimmedString(
    value["prompt"],
    MAXIMUM_QUESTION_PROMPT_LENGTH,
  );
  if (id === undefined || !ID_PATTERN.test(id) || prompt === undefined) {
    return undefined;
  }

  switch (value["type"]) {
    case "free_text": {
      const maxLength = boundedInteger(
        value["maxLength"],
        1,
        MAXIMUM_QUESTION_TEXT_LENGTH,
      );
      const minLength =
        value["minLength"] === undefined
          ? undefined
          : boundedInteger(value["minLength"], 0, MAXIMUM_QUESTION_TEXT_LENGTH);
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
          : boundedInteger(value["maxSelections"], 1, maximum);
      const minSelections =
        value["minSelections"] === undefined
          ? undefined
          : boundedInteger(value["minSelections"], 0, maximum);
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
  if (!isRecord(value) || !hasOnlyKeys(value, ["questions"])) {
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
  return { questions };
}

function selectedValues(
  value: unknown,
  question: MultiChoiceQuestion,
): readonly string[] | undefined {
  const values = stringArray(value);
  if (values === undefined) {
    return undefined;
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
    : [...values];
}

export function askQuestionAnswerValue(
  value: unknown,
  question: AskQuestion,
): readonly string[] | string | undefined {
  switch (question.type) {
    case "free_text": {
      const normalized = readBoundedTrimmedString(value, question.maxLength);
      return normalized === undefined ||
        normalized.length < (question.minLength ?? 0)
        ? undefined
        : normalized;
    }
    case "single_choice":
      return readBoundedTrimmedString(value, MAXIMUM_QUESTION_TEXT_LENGTH);
    case "multi_choice":
      return typeof value === "string"
        ? readBoundedTrimmedString(value, MAXIMUM_QUESTION_TEXT_LENGTH)
        : selectedValues(value, question);
  }
}

export function readAskQuestionAnswers(
  value: unknown,
  questions: readonly AskQuestion[],
): AskQuestionAnswers | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["answers"]) ||
    !Array.isArray(value["answers"]) ||
    value["answers"].length !== questions.length
  ) {
    return undefined;
  }
  const rawAnswers: readonly unknown[] = value["answers"];
  const answers: AskQuestionAnswer[] = [];
  for (const question of questions) {
    const matches = rawAnswers.filter(
      (candidate) =>
        isRecord(candidate) && candidate["questionId"] === question.id,
    );
    const candidate = matches[0];
    if (
      matches.length !== 1 ||
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["questionId", "value"])
    ) {
      return undefined;
    }
    const answer = askQuestionAnswerValue(candidate["value"], question);
    if (answer === undefined) {
      return undefined;
    }
    answers.push({ questionId: question.id, value: answer });
  }
  return { answers };
}

export function readPendingAskQuestions(
  value: unknown,
): PendingAskQuestions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = readAskQuestionsInput({ questions: value["questions"] });
  const createdAt = value["createdAt"];
  const executionGeneration = value["executionGeneration"];
  const id = value["id"];
  const toolCallId = value["toolCallId"];
  return input !== undefined &&
    Number.isSafeInteger(createdAt) &&
    Number(createdAt) >= 0 &&
    Number.isSafeInteger(executionGeneration) &&
    Number(executionGeneration) >= 0 &&
    typeof id === "string" &&
    COMMAND_ID_PATTERN.test(id) &&
    typeof toolCallId === "string" &&
    COMMAND_ID_PATTERN.test(toolCallId) &&
    hasOnlyKeys(value, [
      "createdAt",
      "executionGeneration",
      "id",
      "questions",
      "toolCallId",
    ])
    ? {
        ...input,
        createdAt: Number(createdAt),
        executionGeneration: Number(executionGeneration),
        id,
        toolCallId,
      }
    : undefined;
}

export function readAnswerQuestionsRealtimePayload(
  value: unknown,
): AnswerQuestionsRealtimePayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestId = value["requestId"];
  const sessionId = value["sessionId"];
  const workspaceId = value["workspaceId"];
  const answers = value["answers"];
  return typeof requestId === "string" &&
    COMMAND_ID_PATTERN.test(requestId) &&
    typeof sessionId === "string" &&
    COMMAND_ID_PATTERN.test(sessionId) &&
    (workspaceId === undefined ||
      (typeof workspaceId === "string" &&
        COMMAND_ID_PATTERN.test(workspaceId))) &&
    Array.isArray(answers) &&
    hasOnlyKeys(value, ["answers", "requestId", "sessionId", "workspaceId"])
    ? {
        answers,
        requestId,
        sessionId,
        ...(typeof workspaceId === "string" ? { workspaceId } : {}),
      }
    : undefined;
}

export function canonicalAskQuestionsResult(
  answers: AskQuestionAnswers,
): string {
  return JSON.stringify(answers, null, 2);
}
