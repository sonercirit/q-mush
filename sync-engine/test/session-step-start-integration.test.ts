import { expect, test } from "vitest";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { SESSION_ID } from "./session-integration-fixtures.ts";
import { createStartedDeferredSession } from "./session-integration-helpers.ts";

test("a model step in flight persists its step start for reloads", async () => {
  const { model, setup, ...started } = await createStartedDeferredSession();
  const detail = () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
  expect(started.created.status).toBe(201);

  // The deferred model is mid-request: the runtime -> store composition
  // must already have persisted the step start.
  const running = detail();
  expect(running?.status).toBe("running");
  expect(running?.stepStartedAt).not.toBeNull();

  const drain = setup.sessions.drain();
  model.resolveContent("One durable answer.");
  await drain;

  const finished = detail();
  expect(finished?.status).toBe("idle");
  expect(finished?.stepStartedAt).toBeNull();
  setup.database.$client.close();
});
