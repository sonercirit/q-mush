import { expect, test } from "bun:test";
import { submitFormOnControlEnter } from "../client-actions.ts";
import { SESSIONS_PATH } from "../routes.ts";
import { SessionController } from "../session-controller.ts";
import {
  expectRefreshToRemainSilent,
  requestUrl,
} from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

test("Control+Enter submits a form while Enter remains available", () => {
  let prevented = 0;
  let submissions = 0;
  const event = {
    ctrlKey: false,
    key: "Enter",
    preventDefault: () => {
      prevented += 1;
    },
  };
  const form = {
    requestSubmit: () => {
      submissions += 1;
    },
  };

  submitFormOnControlEnter(event, form);

  expect(prevented).toBe(0);
  expect(submissions).toBe(0);

  submitFormOnControlEnter({ ...event, ctrlKey: true }, form);

  expect(prevented).toBe(1);
  expect(submissions).toBe(1);
});

test("an unchanged session refresh does not notify the view", async () => {
  await expectRefreshToRemainSilent(
    (onChange) => new SessionController(onChange),
    (input) => {
      const path = new URL(requestUrl(input), "http://localhost").pathname;
      return Promise.resolve(
        Response.json(
          path === SESSIONS_PATH
            ? { sessions: [{ ...TEST_SESSION_DETAIL, messages: undefined }] }
            : TEST_SESSION_DETAIL,
        ),
      );
    },
  );
});
