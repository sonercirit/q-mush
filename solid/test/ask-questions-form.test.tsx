import { expect, test } from "vitest";
import { AskQuestionsForm } from "../ask-questions-client.tsx";
import { PENDING_QUESTIONS_FIXTURE } from "./ask-questions-fixtures.ts";
import { renderSolidToString } from "./render-solid.tsx";

test("renders an accessible form for all pending question kinds", () => {
  const html = renderSolidToString(() => (
    <AskQuestionsForm
      onSubmit={() => undefined}
      pending={{
        ...PENDING_QUESTIONS_FIXTURE,
        questions: PENDING_QUESTIONS_FIXTURE.questions.map((question) =>
          question.id === "detail"
            ? {
                ...question,
                maxLength: 100,
                prompt: "Add context <img src=x onerror=alert(1)>",
              }
            : question,
        ),
      }}
      submitting={false}
    />
  ));

  expect(html).toContain('data-question-request-id="request-1"');
  expect(html).toContain("Your input is needed");
  expect(html).toContain("Add context");
  expect(html).toContain("<fieldset>");
  expect(html).toContain("<legend");
  expect(html).toContain('type="radio"');
  expect(html.match(/name="direction"/gu)).toHaveLength(2);
  expect(html).toContain('type="checkbox"');
  expect(html.match(/<textarea/gu)).toHaveLength(3);
  expect(html.match(/placeholder="Or type your own answer…"/gu)).toHaveLength(
    2,
  );
  expect(html).toContain("Submit answers");
  expect(html).toContain("&lt;img src=x onerror=alert(1)>");
  expect(html).not.toContain("<img src=x onerror=alert(1)>");
});
