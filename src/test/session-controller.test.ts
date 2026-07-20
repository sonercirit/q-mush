import { test } from "bun:test";
import { SESSIONS_PATH } from "../routes.ts";
import { SessionController } from "../session-controller.ts";
import {
  expectRefreshToRemainSilent,
  requestUrl,
} from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

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
