import { expect, test } from "vitest";
import { createDrizzleAuthStore } from "../auth-store.ts";
import { createSchemaCompatibleTestDatabase } from "./authenticated-integration-test-helpers.ts";
import { createTestRequestHandler } from "./server.test.ts";

test("local active-view route authenticates, validates, and isolates transcripts", async () => {
  const database = createSchemaCompatibleTestDatabase();
  const generatedIds = [
    "owned",
    "workspace-owned",
    "session-owned",
    "other",
    "workspace-other",
    "session-other",
  ];
  const authStore = createDrizzleAuthStore(
    database,
    () => generatedIds.shift() ?? "unexpected",
  );
  authStore.createSession(
    "token",
    {
      email: "owned@example.com",
      googleSubject: "owned-google",
      name: "Owned",
    },
    Date.now() + 60_000,
    Date.now(),
  );
  authStore.createSession(
    "other-token",
    {
      email: "other@example.com",
      googleSubject: "other-google",
      name: "Other",
    },
    Date.now() + 60_000,
    Date.now(),
  );
  database.$client.run("PRAGMA foreign_keys = OFF");
  for (const [id, userId] of [
    ["owned-session", "owned"],
    ["other-session", "other"],
  ] as const) {
    database.$client.run(
      "INSERT INTO agent_sessions (id, user_id, workspace_id, runner_id, provider_credential_id, title, status, provider, model, reasoning_effort, tools, working_directory, execution_environment, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, 'workspace', 'runner', 'credential', ?, 'idle', 'openai', 'model', 'none', '[]', '/', 'bare_metal', 1, 1, ?, ?, 0)",
      [id, userId, id, userId, userId],
    );
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, ?, 'assistant', ?, 1, 1, ?, ?, 0)",
      [`${id}-message`, userId, id, `${userId} transcript`, userId, userId],
    );
  }
  const route = createTestRequestHandler(database);
  const send = (path: string, method = "GET", authenticated = true) =>
    route(
      new Request(`http://localhost${path}`, {
        headers: authenticated ? { cookie: "q_mush_session=token" } : {},
        method,
      }),
    );
  expect(
    (await send("/api/local/view?entity=agent_sessions&limit=10", "GET", false))
      .status,
  ).toBe(401);
  expect(
    (await send("/api/local/view?entity=agent_sessions&limit=10", "POST"))
      .status,
  ).toBe(405);
  expect((await send("/api/local/view?entity=unknown&limit=10")).status).toBe(
    400,
  );
  expect(
    (await send("/api/local/view?entity=agent_sessions&limit=101")).status,
  ).toBe(400);
  expect(
    (await send("/api/local/view?entity=agent_messages&limit=10")).status,
  ).toBe(400);
  const ownedMessagePath = new URLSearchParams({
    entity: "agent_messages",
    limit: "10",
    sessionId: "owned-session",
  });
  const response = await send(`/api/local/view?${ownedMessagePath.toString()}`);
  expect(response.status).toBe(200);
  const ownedBody: unknown = await response.json();
  expect(ownedBody).toMatchObject({
    records: [{ content: "owned transcript", id: "owned-session-message" }],
  });
  const hidden = await send(
    "/api/local/view?entity=agent_messages&sessionId=other-session&limit=10",
  );
  expect(await hidden.json()).toMatchObject({ records: [] });
  database.$client.close();
});
