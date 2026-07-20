import { test } from "bun:test";
import { SESSIONS_PATH } from "../routes.ts";
import { SessionController } from "../session-controller.ts";
import { expectRefreshToRemainSilent } from "./controller-test-helpers.ts";

const SESSION = {
  createdAt: 1,
  credentialId: "credential-1",
  id: "session-1",
  messages: [],
  model: "gpt-5-codex",
  provider: "openai",
  reasoningEffort: null,
  runnerId: "runner-1",
  status: "idle",
  title: "Fix the selects",
  updatedAt: 2,
  workingDirectory: ".",
};

test("an unchanged session refresh does not notify the view", async () => {
  await expectRefreshToRemainSilent(
    (onChange) => new SessionController(onChange),
    (input) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(inputUrl, "http://localhost").pathname;
      return Promise.resolve(
        Response.json(
          path === SESSIONS_PATH
            ? { sessions: [{ ...SESSION, messages: undefined }] }
            : SESSION,
        ),
      );
    },
  );
});
