import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { readToolSettings } from "../shared/tool-limits.ts";
import type { GoogleAuth } from "./auth.ts";
import { AuthenticatedCollectionIntegration } from "./authenticated-collection-integration.ts";
import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { ToolSettingsStore } from "./tool-settings-store.ts";

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

class DrizzleToolSettingsIntegration
  extends AuthenticatedCollectionIntegration
  implements ToolSettingsIntegration
{
  readonly #now: () => number;
  readonly #realtime: RealtimeHub | undefined;
  readonly store: ToolSettingsStore;

  constructor(auth: GoogleAuth, dependencies: ToolSettingsDependencies) {
    super(auth);
    this.#now = dependencies.now ?? Date.now;
    this.#realtime = dependencies.realtime;
    this.store = new ToolSettingsStore(
      dependencies.database ?? createDatabase(":memory:"),
      dependencies.generateId ?? createUuidV7,
    );
  }

  collection(request: Request): Promise<Response> | Response {
    const current = (userId: string): Response =>
      createJsonResponse(this.store.read(userId));
    return this.collectionRoute(request, {
      GET: current,
      PUT: (userId) => this.#write(request, userId),
    });
  }

  async #write(request: Request, userId: string): Promise<Response> {
    const settings = await parseJsonRequest(request, readToolSettings);
    if (settings === undefined) {
      return createApiError("invalid_tool_settings", 400);
    }
    const saved = this.store.set(userId, settings, this.#now());
    // User-wide publication reaches this user's connected workspace tabs only.
    this.#realtime?.publishUserAllWorkspaces(userId, {
      settings: saved,
      type: "tool_settings",
    });
    return createJsonResponse(saved);
  }
}

export function createToolSettingsIntegration(
  auth: GoogleAuth,
  dependencies: ToolSettingsDependencies = {},
): ToolSettingsIntegration {
  return new DrizzleToolSettingsIntegration(auth, dependencies);
}
