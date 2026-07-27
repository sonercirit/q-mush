const ID_PARAMETER = {
  maxLength: 64,
  minLength: 1,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
  type: "string",
} as const;

const PROMPT_PARAMETER = {
  maxLength: 1_000,
  minLength: 1,
  type: "string",
} as const;

const OPTIONS_PARAMETER = {
  items: {
    additionalProperties: false,
    properties: {
      label: {
        maxLength: 200,
        minLength: 1,
        type: "string",
      },
      value: {
        maxLength: 200,
        minLength: 1,
        type: "string",
      },
    },
    required: ["label", "value"],
    type: "object",
  },
  maxItems: 12,
  minItems: 2,
  type: "array",
} as const;

const questionProperties = {
  id: ID_PARAMETER,
  prompt: PROMPT_PARAMETER,
} as const;

const choiceProperties = {
  ...questionProperties,
  options: OPTIONS_PARAMETER,
} as const;

const CHOICE_QUESTION_KEYS = ["id", "prompt", "type", "options"] as const;

export const ASK_QUESTIONS_TOOL_NAME = "ask_questions";

export const ASK_QUESTIONS_TOOL_DEFINITION = {
  description:
    "Ask the user one to eight bounded free-text, single-choice, or multiple-choice questions. The session pauses until the authenticated user answers. Call this only as a direct tool; it cannot run through parallel.",
  name: ASK_QUESTIONS_TOOL_NAME,
  parameters: {
    additionalProperties: false,
    properties: {
      questions: {
        description: "Questions to present together",
        items: {
          oneOf: [
            {
              additionalProperties: false,
              properties: {
                ...questionProperties,
                maxLength: { maximum: 4_000, minimum: 1, type: "integer" },
                minLength: { maximum: 4_000, minimum: 0, type: "integer" },
                type: { const: "free_text", type: "string" },
              },
              required: ["id", "prompt", "type", "maxLength"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                ...choiceProperties,
                type: { const: "single_choice", type: "string" },
              },
              required: CHOICE_QUESTION_KEYS,
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                ...choiceProperties,
                maxSelections: {
                  maximum: 12,
                  minimum: 1,
                  type: "integer",
                },
                minSelections: {
                  maximum: 12,
                  minimum: 0,
                  type: "integer",
                },
                type: { const: "multi_choice", type: "string" },
              },
              required: CHOICE_QUESTION_KEYS,
              type: "object",
            },
          ],
        },
        maxItems: 8,
        minItems: 1,
        type: "array",
      },
    },
    required: ["questions"],
    type: "object",
  },
} as const;
