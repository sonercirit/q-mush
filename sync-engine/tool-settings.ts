import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { readToolSettings } from "../shared/tool-limits.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import {
  createToolSettingsStore,
  type ToolSettingsStore,
} from "./tool-settings-store.ts";

export interface ToolSettingsIntegration {
  readonly store: ToolSettingsStore;
  collection(request: Request): Promise<Response> | Response;
}

interface ToolSettingsDependencies {
  readonly database?: AppDatabase;
  readonly generateId?: IdGenerator;
  readonly now?: () => number;
  readonly realtime?: RealtimeHub;
}

type ToolSettingsMethod = "GET" | "PUT";

function isToolSettingsMethod(method: string): method is ToolSettingsMethod {
  return method === "GET" || method === "PUT";
}

export function createToolSettingsIntegration(
  auth: GoogleAuth,
  dependencies: ToolSettingsDependencies = {},
): ToolSettingsIntegration {
  const now = dependencies.now ?? Date.now;
  const realtime = dependencies.realtime;
  const store = createToolSettingsStore(
    dependencies.database ?? createDatabase(":memory:"),
    dependencies.generateId ?? createUuidV7,
  );
  const write = async (request: Request, userId: string): Promise<Response> => {
    const settings = await parseJsonRequest(request, readToolSettings);
    if (settings === undefined) {
      return createApiError("invalid_tool_settings", 400);
    }
    const saved = store.set(userId, settings, now());
    // User-wide publication reaches this user's connected workspace tabs only.
    realtime?.publishUserAllWorkspaces(userId, {
      settings: saved,
      type: "tool_settings",
    });
    return createJsonResponse(saved);
  };
  const collection = (request: Request): Promise<Response> | Response =>
    withAuthenticatedUser(auth, request, ({ id: userId }) => {
      if (!isToolSettingsMethod(request.method)) {
        return createMethodNotAllowedResponse("GET, PUT");
      }
      const handlers: Record<
        ToolSettingsMethod,
        () => Promise<Response> | Response
      > = {
        GET: () => createJsonResponse(store.read(userId)),
        PUT: () => write(request, userId),
      };
      return handlers[request.method]();
    });
  return { collection, store };
}
