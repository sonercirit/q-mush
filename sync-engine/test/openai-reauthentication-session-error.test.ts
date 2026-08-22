import { afterEach, describe, expect, test } from "vitest";
import { ProviderCredentialReauthenticationRequiredError } from "../provider-error.ts";
import { SessionFinisher } from "../session-finisher.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { closeTrackedDatabases } from "./database-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

const databases: ReturnType<typeof createStore>["database"][] = [];

afterEach(() => {
  closeTrackedDatabases(databases);
});

describe("OpenAI re-login session failure", () => {
  test("persists an explicit session error without provider secrets", () => {
    const setup = createStore();
    databases.push(setup.database);
    const detail = createTestSession(setup.store);
    const finisher = new SessionFinisher({
      actions: { finished: () => undefined, stopChildren: () => undefined },
      notify: () => undefined,
      now: () => 1_700_000_000_000,
      store: setup.store,
    });
    const secret = "oauth-refresh-token-that-must-not-leak";
    const error = new ProviderCredentialReauthenticationRequiredError(
      "OpenAI",
      401,
    );
    Object.defineProperty(error, "cause", { value: { secret } });

    finisher.finish(detail, TEST_USER_ID, error);

    const failed = setup.store.get(TEST_USER_ID, detail.id);
    expect(failed).toMatchObject({
      messages: [
        { role: "user" },
        {
          content:
            "Session failed: OpenAI login has expired. Connect the account again to continue.",
          role: "error",
        },
      ],
      status: "failed",
    });
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
});
