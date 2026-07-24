import { createSignal, For, Show, type JSX } from "solid-js";
import type {
  AskQuestion,
  AskQuestionAnswer,
  AskQuestionAnswers,
  PendingAskQuestions,
} from "../shared/ask-questions.ts";

function initialAnswer(question: AskQuestion): AskQuestionAnswer {
  return {
    questionId: question.id,
    value: question.type === "multi_choice" ? [] : "",
  };
}

function selections(answer: AskQuestionAnswer): readonly string[] {
  const selected: string[] = [];
  if (Array.isArray(answer.value)) {
    for (const value of answer.value) {
      if (typeof value === "string") {
        selected.push(value);
      }
    }
  }
  return selected;
}

function includesSelection(answer: AskQuestionAnswer, value: string): boolean {
  return Array.isArray(answer.value) && answer.value.includes(value);
}

function questionIsValid(
  question: AskQuestion,
  answer: AskQuestionAnswer,
): boolean {
  switch (question.type) {
    case "free_text": {
      if (typeof answer.value !== "string") {
        return false;
      }
      const length = answer.value.trim().length;
      return (
        length >= (question.minLength ?? 0) && length <= question.maxLength
      );
    }
    case "single_choice":
      return (
        typeof answer.value === "string" &&
        question.options.some(({ value }) => value === answer.value)
      );
    case "multi_choice":
      return (
        Array.isArray(answer.value) &&
        answer.value.length >= (question.minSelections ?? 0) &&
        answer.value.length <=
          (question.maxSelections ?? question.options.length)
      );
  }
}

function ChoiceLabel(props: {
  readonly checked: boolean;
  readonly group: string;
  readonly label: string;
  readonly multiple: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly value: string;
}): JSX.Element {
  return (
    <label class="flex cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 has-checked:border-violet-300/40 has-checked:bg-violet-300/10">
      <input
        checked={props.checked}
        class="accent-violet-300"
        disabled={props.disabled}
        name={props.multiple ? undefined : props.group}
        onChange={(event) => {
          props.onChange(event.currentTarget.checked);
        }}
        type={props.multiple ? "checkbox" : "radio"}
        value={props.value}
      />
      {props.label}
    </label>
  );
}

export function AskQuestionsForm(props: {
  readonly pending: PendingAskQuestions;
  readonly submitting: boolean;
  readonly onSubmit: (answers: AskQuestionAnswers) => void;
}): JSX.Element {
  const [answers, setAnswers] = createSignal(
    props.pending.questions.map(initialAnswer),
  );
  const answerFor = (questionId: string): AskQuestionAnswer =>
    answers().find(({ questionId: id }) => id === questionId) ?? {
      questionId,
      value: "",
    };
  const replaceAnswer = (answer: AskQuestionAnswer): void => {
    setAnswers((current) =>
      current.map((existing) =>
        existing.questionId === answer.questionId ? answer : existing,
      ),
    );
  };
  const textAnswer = (questionId: string): string => {
    const value = answerFor(questionId).value;
    return typeof value === "string" ? value : "";
  };
  const valid = (): boolean =>
    props.pending.questions.every((question) =>
      questionIsValid(question, answerFor(question.id)),
    );

  return (
    <form
      class="rounded-xl border border-violet-300/30 bg-violet-300/10 p-4"
      data-question-request-id={props.pending.id}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid() && !props.submitting) {
          props.onSubmit({ answers: answers() });
        }
      }}
    >
      <p class="text-xs font-semibold tracking-wide text-violet-200 uppercase">
        Your input is needed
      </p>
      <div class="mt-4 space-y-5">
        <For each={props.pending.questions}>
          {(question, index) => {
            const answer = (): AskQuestionAnswer => answerFor(question.id);
            return (
              <fieldset>
                <legend class="text-sm font-medium text-white">
                  {`${String(index() + 1)}. ${question.prompt}`}
                </legend>
                <Show when={question.type === "free_text" && question}>
                  {(freeText) => (
                    <>
                      <textarea
                        class="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white focus:border-violet-300/50 focus:outline-none"
                        maxlength={freeText().maxLength}
                        minlength={freeText().minLength ?? 0}
                        disabled={props.submitting}
                        onInput={(event) => {
                          replaceAnswer({
                            questionId: question.id,
                            value: event.currentTarget.value,
                          });
                        }}
                        required={(freeText().minLength ?? 0) > 0}
                        value={textAnswer(question.id)}
                      />
                      <p class="mt-1 text-xs text-slate-500">
                        {`${String(freeText().minLength ?? 0)}–${String(freeText().maxLength)} characters`}
                      </p>
                    </>
                  )}
                </Show>
                <Show when={question.type !== "free_text" && question}>
                  {(choice) => (
                    <div class="mt-2 grid gap-2 sm:grid-cols-2">
                      <For each={choice().options}>
                        {(option) => {
                          const multiple = choice().type === "multi_choice";
                          const checked = (): boolean =>
                            multiple
                              ? includesSelection(answer(), option.value)
                              : answer().value === option.value;
                          const multipleChoice =
                            question.type === "multi_choice"
                              ? question
                              : undefined;
                          const maximumSelections =
                            multipleChoice?.maxSelections ??
                            multipleChoice?.options.length ??
                            1;
                          const selectionDisabled = (): boolean =>
                            props.submitting ||
                            (multiple &&
                              !checked() &&
                              selections(answer()).length >= maximumSelections);
                          return (
                            <ChoiceLabel
                              checked={checked()}
                              disabled={selectionDisabled()}
                              group={question.id}
                              label={option.label}
                              multiple={multiple}
                              onChange={(selected) => {
                                const current = answer();
                                replaceAnswer({
                                  questionId: question.id,
                                  value: multiple
                                    ? selected
                                      ? [...selections(current), option.value]
                                      : selections(current).filter(
                                          (value) => value !== option.value,
                                        )
                                    : option.value,
                                });
                              }}
                              value={option.value}
                            />
                          );
                        }}
                      </For>
                    </div>
                  )}
                </Show>
              </fieldset>
            );
          }}
        </For>
      </div>
      <button
        class="mt-5 rounded-xl bg-violet-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!valid() || props.submitting}
        type="submit"
      >
        {props.submitting ? "Submitting answers…" : "Submit answers"}
      </button>
    </form>
  );
}
