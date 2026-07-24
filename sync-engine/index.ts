import { createDatabase } from "../shared/database.ts";
import { readDatabasePath } from "../shared/database/config.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { createGoogleAuthFromEnvironment } from "./auth.ts";
import { createBraveSearchSkillFromEnvironment } from "./brave-search.ts";
import {
  createOpenAiIntegrationFromEnvironment,
  createOpenAiLoopbackCallbackHandler,
  OPENAI_LOOPBACK_CALLBACK_PORT,
  usesOpenAiLoopbackCallback,
} from "./openai.ts";
import { createOpenRouterIntegrationFromEnvironment } from "./openrouter.ts";
import { renderPages } from "./pages.ts";
import { RealtimeHub } from "./realtime-hub.ts";
import {
  createRealtimeIntegration,
  isRealtimePath,
  type QmushWebSocketData,
} from "./realtime.ts";
import { buildRunnerExecutableProvider } from "./runner-executable.ts";
import { createRunnerIntegration } from "./runners.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "./server.ts";
import { createSessionIntegration } from "./sessions.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import { createWorkspaceIntegration } from "./workspaces.ts";

const database = createDatabase(readDatabasePath(Bun.env));
const [clientJavaScript, pages, runnerExecutables, stylesheet] =
  await Promise.all([
    buildClientJavaScript(),
    renderPages(),
    buildRunnerExecutableProvider(),
    buildClientStylesheet(),
  ]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env, { database });
const braveSearch = createBraveSearchSkillFromEnvironment(Bun.env, googleAuth, {
  database,
});
const openAi = createOpenAiIntegrationFromEnvironment(Bun.env, googleAuth, {
  database,
});
const openRouter = createOpenRouterIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  { database },
);
const runners = createRunnerIntegration(googleAuth, { database });
const workspaceStore = new WorkspaceStore(database);
const workspaces = createWorkspaceIntegration({
  auth: googleAuth,
  store: workspaceStore,
});
const realtimeHub = new RealtimeHub();
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { openai: openAi, openrouter: openRouter },
  { braveSearch, database, realtime: realtimeHub, workspaces },
);
const realtime = createRealtimeIntegration({
  auth: googleAuth,
  hub: realtimeHub,
  runnerVersion: runnerExecutables.version,
  runners,
  sessions,
  workspaceExists: (userId, workspaceId) =>
    workspaceId === GLOBAL_WORKSPACE_ID ||
    workspaces.exists(userId, workspaceId),
});
const handleRequest = createRequestHandler(
  clientJavaScript,
  stylesheet,
  pages,
  googleAuth,
  openAi,
  openRouter,
  braveSearch,
  runners,
  sessions,
  workspaces,
  runnerExecutables,
);
let callbackServer: Bun.Server<undefined> | undefined;
const server = Bun.serve<QmushWebSocketData>({
  fetch(request, server) {
    if (isRealtimePath(request)) {
      return realtime.upgrade(request, server);
    }

    return handleRequest(request);
  },
  websocket: realtime.websocket,
});

if (usesOpenAiLoopbackCallback(Bun.env)) {
  try {
    callbackServer = Bun.serve({
      fetch: createOpenAiLoopbackCallbackHandler(openAi, server.url),
      hostname: "localhost",
      port: OPENAI_LOOPBACK_CALLBACK_PORT,
    });
    console.log(`OpenAI OAuth callback is listening at ${callbackServer.url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`OpenAI OAuth callback could not start: ${message}`);
  }
}

let shuttingDown = false;

async function shutDown(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await sessions.drain();
  await Promise.all([server.stop(), callbackServer?.stop()]);
  database.$client.close();
}

process.on("SIGINT", () => {
  void shutDown();
});
process.on("SIGTERM", () => {
  void shutDown();
});

console.log(`Q Mush is running at ${server.url}`);
