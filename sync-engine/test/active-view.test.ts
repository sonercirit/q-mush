import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { engineActiveViewResponse } from "../active-view.ts";

let activeViewDatabase: AppDatabase | undefined;
afterEach(() => activeViewDatabase?.$client.close());

test("migration engine serves an owned bounded labeled active view", async () => {
  activeViewDatabase = createDatabase(
    join(mkdtempSync(join(tmpdir(), "engine-view-")), "db"),
  );
  for (const id of ["u", "other"])
    activeViewDatabase.$client.run(
      "INSERT INTO users (id, google_subject, email, name, created_at, updated_at, created_by_id, updated_by_id, is_deleted) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 0)",
      [id, `google-${id}`, `${id}@example.com`, id, id, id],
    );
  activeViewDatabase.$client.run("DROP TABLE agent_sessions");
  activeViewDatabase.$client.run(
    "CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
  );
  for (const [id, userId] of [
    ["s1", "u"],
    ["s2", "u"],
    ["hidden", "other"],
  ] as const)
    activeViewDatabase.$client.run("INSERT INTO agent_sessions VALUES (?, ?)", [
      id,
      userId,
    ]);
  const response = engineActiveViewResponse(
    activeViewDatabase,
    "u",
    new URL("http://engine/api/local/view?limit=1&entity=agent_sessions"),
  );
  expect(response.ok).toBe(true);
  expect(await response.json()).toMatchObject({
    complete: false,
    origin: "engine",
    partial: true,
    records: [{ id: "s1" }],
  });
});
