import { expect, test } from "vitest";
import { AskQuestionsForm } from "../ask-questions-client.tsx";
import { renderSolidToString } from "./render-solid.tsx";

test("renders an accessible form for all pending question kinds", () => {
  const html = renderSolidToString(() => (
    <AskQuestionsForm
      onSubmit={() => undefined}
      pending={{
        createdAt: 1,
        id: "request-1",
        questions: [
          /* jscpd:ignore-start */
          {
            id: "detail",
            maxLength: 100,
            minLength: 1,
            prompt: "Add context <img src=x onerror=alert(1)>",
            type: "free_text",
          },
          {
            id: "direction",
            options: [
              { label: "Proceed", value: "proceed" },
              { label: "Stop", value: "stop" },
            ],
            prompt: "Choose a direction",
            type: "single_choice",
          },
          {
            id: "checks",
            options: [
              { label: "Tests", value: "tests" },
              { label: "Lint", value: "lint" },
            ],
            prompt: "Choose checks",
            type: "multi_choice",
          },
          /* jscpd:ignore-end */
        ],
        toolCallId: "call-1",
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
  expect(html).toContain("Submit answers");
  expect(html).toContain("&lt;img src=x onerror=alert(1)>");
  expect(html).not.toContain("<img src=x onerror=alert(1)>");
});
