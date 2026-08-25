import { expect, test } from "vitest";
import { sha256 } from "../../shared/sha256.ts";
import { isRecord } from "../../shared/validation.ts";
import { createDrizzleAuthStore } from "../auth-store.ts";
import {
  TEST_ATTACHMENT_BYTES,
  TEST_ATTACHMENT_DATA,
  TEST_ATTACHMENT_DIGEST,
} from "./account-export-test-attachments.ts";
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
  const data = TEST_ATTACHMENT_DATA;
  for (const [id, userId] of [
    ["owned-session", "owned"],
    ["other-session", "other"],
  ] as const) {
    database.$client.run(
      "INSERT INTO agent_sessions (id, user_id, workspace_id, runner_id, provider_credential_id, title, status, provider, model, reasoning_effort, tools, working_directory, execution_environment, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, 'workspace', 'runner', 'credential', ?, 'idle', 'openai', 'model', 'none', '[]', '/', 'bare_metal', 1, 1, ?, ?, 0)",
      [id, userId, id, userId, userId],
    );
    const messageData =
      userId === "owned"
        ? JSON.stringify([{ data, mediaType: "image/png" }])
        : null;
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, images, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, ?, 'assistant', ?, ?, 1, 1, ?, ?, 0)",
      [
        `${id}-message`,
        userId,
        id,
        `${userId} transcript`,
        messageData,
        userId,
        userId,
      ],
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
  if (!isRecord(ownedBody) || !Array.isArray(ownedBody["records"]))
    throw new Error("Expected local view records");
  const ownedRecord: unknown = ownedBody["records"][0];
  if (!isRecord(ownedRecord)) throw new Error("Expected a local view record");
  const parsedImages: unknown = JSON.parse(String(ownedRecord["images"]));
  if (!Array.isArray(parsedImages)) throw new Error("Expected message images");
  const images = parsedImages.filter(isRecord);
  const digest = TEST_ATTACHMENT_DIGEST;
  expect(images).toEqual([{ digest, mediaType: "image/png" }]);
  expect(images[0]).not.toHaveProperty("data");
  const blob = await send(`/api/local/blob/${digest}`);
  expect(blob.status).toBe(200);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
    TEST_ATTACHMENT_BYTES,
  );
  const hidden = await send(
    "/api/local/view?entity=agent_messages&sessionId=other-session&limit=10",
  );
  expect(await hidden.json()).toMatchObject({ records: [] });
  database.$client.close();
});

test("local blob route authenticates, scopes blobs, validates methods, and resumes ranges", async () => {
  const database = createSchemaCompatibleTestDatabase();
  const ids = ["owned", "owned-session", "other", "other-session"];
  const authStore = createDrizzleAuthStore(
    database,
    () => ids.shift() ?? "unexpected",
  );
  for (const [token, subject] of [
    ["token", "owned"],
    ["other-token", "other"],
  ] as const)
    authStore.createSession(
      token,
      {
        email: `${subject}@example.com`,
        googleSubject: subject,
        name: subject,
      },
      9_000_000_000_000,
      1,
    );
  database.$client.run("PRAGMA foreign_keys = OFF");
  const bytes = Uint8Array.from([1, 2, 3]);
  for (const userId of ["owned", "other"] as const) {
    const data = (
      userId === "owned" ? bytes : Uint8Array.from([4, 5, 6])
    ).toBase64();
    database.$client.run(
      "INSERT INTO agent_sessions (id, user_id, workspace_id, runner_id, provider_credential_id, title, status, provider, model, reasoning_effort, tools, working_directory, execution_environment, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, 'w', 'r', 'c', 't', 'idle', 'openai', 'm', 'none', '[]', '/', 'bare_metal', 1, 1, ?, ?, 0)",
      [`s-${userId}`, userId, userId, userId],
    );
    database.$client.run(
      "INSERT INTO agent_messages (id, user_id, session_id, role, content, images, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, ?, 'user', '', ?, 1, 1, ?, ?, 0)",
      [
        `m-${userId}`,
        userId,
        `s-${userId}`,
        JSON.stringify([{ data, mediaType: "image/png" }]),
        userId,
        userId,
      ],
    );
  }
  const route = createTestRequestHandler(database);
  const digest = sha256(bytes);
  const send = (token: string | undefined, method = "GET", range?: string) =>
    route(
      new Request(`http://localhost/api/local/blob/${digest}`, {
        headers: {
          ...(token !== undefined && { cookie: `q_mush_session=${token}` }),
          ...(range !== undefined && { range }),
        },
        method,
      }),
    );
  expect((await send(undefined)).status).toBe(401);
  expect((await send("token", "POST")).status).toBe(405);
  expect((await send("other-token")).status).toBe(404);
  const whole = await send("token");
  expect(whole.status).toBe(200);
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
  const partial = await send("token", "GET", "bytes=1-");
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 1-2/3");
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(1));
  database.$client.close();
});
