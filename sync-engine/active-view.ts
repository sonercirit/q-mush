import {
  validActiveViewLimit,
  type ActiveView,
} from "../shared/active-view.ts";
import type { AppDatabase } from "../shared/database.ts";

import { runnerExportBlobResponse } from "./account-export-http.ts";
import { exportAccountBlob } from "./account-export.ts";
import { createMethodNotAllowedResponse } from "./http.ts";

export function engineLocalResponse(
  database: AppDatabase,
  request: Request,
  userId: string | undefined,
): Response {
  if (request.method !== "GET") return createMethodNotAllowedResponse("GET");
  if (userId === undefined)
    return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/local/blob/"))
    return runnerExportBlobResponse(
      exportAccountBlob(database, userId, url.pathname.slice(16)),
      request.headers.get("range"),
    );
  return engineActiveViewResponse(database, userId, url);
}

const ENTITIES = ["agent_messages", "agent_sessions"] as const;
type Entity = (typeof ENTITIES)[number];

function isEntity(value: string | null): value is Entity {
  return value !== null && ENTITIES.some((entity) => entity === value);
}

function engineActiveViewResponse(
  database: AppDatabase,
  userId: string,
  url: URL,
): Response {
  const entity = url.searchParams.get("entity");
  const limit = Number(url.searchParams.get("limit"));
  if (
    !isEntity(entity) ||
    !validActiveViewLimit(limit) ||
    (entity === "agent_messages" && url.searchParams.get("sessionId") === null)
  )
    return Response.json({ error: "invalid_view" }, { status: 400 });
  const sessionId = url.searchParams.get("sessionId");
  const queries = {
    agent_messages: {
      ownership:
        '"session_id" = ? AND EXISTS (SELECT 1 FROM "agent_sessions" AS owned WHERE owned."id" = "agent_messages"."session_id" AND owned."user_id" = ?)',
      parameters: [sessionId ?? "", userId],
    },
    agent_sessions: { ownership: '"user_id" = ?', parameters: [userId] },
  };
  const { ownership, parameters } = queries[entity];
  const rows = database.$client
    .query<Record<string, unknown>, (string | number)[]>(
      `SELECT * FROM "${entity}" WHERE ${ownership} ORDER BY "id" LIMIT ?`,
    )
    .all(...parameters, limit + 1);
  return Response.json({
    complete: rows.length <= limit,
    origin: "engine",
    partial: true,
    records: rows.slice(0, limit),
  } satisfies ActiveView);
}
