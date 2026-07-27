import type { AppDatabase } from "../shared/database.ts";
import type { GoogleAuth } from "./auth.ts";
import { RealtimeHub } from "./realtime-hub.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import {
  createWorkspaceIntegration,
  type WorkspaceIntegration,
} from "./workspaces.ts";

export interface CoreIntegrationResources {
  readonly realtimeHub: RealtimeHub;
  readonly workspaceStore: WorkspaceStore;
  readonly workspaces: WorkspaceIntegration;
}

export function createCoreIntegrationResources(
  auth: GoogleAuth,
  database: AppDatabase,
): CoreIntegrationResources {
  const workspaceStore = new WorkspaceStore(database);
  return {
    realtimeHub: new RealtimeHub(),
    workspaceStore,
    workspaces: createWorkspaceIntegration({ auth, store: workspaceStore }),
  };
}
