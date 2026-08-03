import { readDatabasePath } from "../shared/database/config.ts";
import { createGoogleAuthFromEnvironment } from "./auth.ts";
import { createBraveSearchSkillFromEnvironment } from "./brave-search.ts";
import { createCoreIntegrationResources } from "./core-integration-resources.ts";
import {
  openDatabaseAndCleanupRepairSnapshots,
  startDatabaseFreeSpaceMonitor,
} from "./database-storage-maintenance.ts";
import {
  databaseVacuumSafetyBytes,
  enableIncrementalVacuum,
  startIncrementalVacuum,
} from "./database-vacuum.ts";
import {
  DatabaseWriteResilience,
  installDatabaseWriteResilience,
} from "./database-write-resilience.ts";
import { EngineHealth } from "./engine-health.ts";
import { createGenericIntegrationFromEnvironment } from "./generic-provider.ts";
import {
  createOpenAiIntegrationFromEnvironment,
  createOpenAiLoopbackCallbackHandler,
  OPENAI_LOOPBACK_CALLBACK_PORT,
  usesOpenAiLoopbackCallback,
} from "./openai.ts";
import { createOpenRouterIntegrationFromEnvironment } from "./openrouter.ts";
import { renderPages } from "./pages.ts";
import { createPromptIntegration } from "./prompts.ts";
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
  readQmushPort,
} from "./server.ts";
import { createSessionsChangedPublisher } from "./session-credential-reassignment-realtime.ts";
import { createSessionIntegration } from "./sessions.ts";

const databasePath = readDatabasePath(Bun.env);
const health = new EngineHealth();
const database = openDatabaseAndCleanupRepairSnapshots(databasePath);
// Run the free-space preflight before the optional full VACUUM rebuild.
const vacuumRequiredBytes = databaseVacuumSafetyBytes(database.$client);
const freeSpace = startDatabaseFreeSpaceMonitor(
  databasePath,
  health,
  vacuumRequiredBytes,
);
const vacuum = enableIncrementalVacuum(database.$client, {
  availableBytes: freeSpace.availableBytes,
});
if (vacuum.skipped) {
  health.degrade(
    "low_disk_space",
    `incremental-vacuum rebuild needs at least ${String(vacuumRequiredBytes)} free bytes and was skipped`,
  );
}
if (vacuum.rebuilt) {
  console.log(
    "Q Mush rebuilt the database once to enable incremental vacuum maintenance",
  );
}
const writeResilience = new DatabaseWriteResilience({ health });
installDatabaseWriteResilience(database, writeResilience);
const vacuumTimer = startIncrementalVacuum(database.$client);
const [clientJavaScript, pages, runnerExecutables, stylesheet] =
  await Promise.all([
    buildClientJavaScript(),
    renderPages(),
    buildRunnerExecutableProvider(),
    buildClientStylesheet(),
  ]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env, { database });
const { realtimeHub, workspaceStore, workspaces } =
  createCoreIntegrationResources(googleAuth, database);
const providerDependencies = {
  database,
  onSessionsChanged: createSessionsChangedPublisher(realtimeHub),
};
const braveSearch = createBraveSearchSkillFromEnvironment(Bun.env, googleAuth, {
  database,
});
const generic = createGenericIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  providerDependencies,
);
const openAi = createOpenAiIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  providerDependencies,
);
const openRouter = createOpenRouterIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  providerDependencies,
);
const runners = createRunnerIntegration(googleAuth, { database });
const prompts = createPromptIntegration(googleAuth, { database });
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { generic, openai: openAi, openrouter: openRouter },
  { braveSearch, database, realtime: realtimeHub, workspaces },
);
const realtime = createRealtimeIntegration({
  auth: googleAuth,
  health,
  hub: realtimeHub,
  runnerVersion: runnerExecutables.version,
  runners,
  sessions,
  workspaceExists: (userId, workspaceId) =>
    workspaceStore.exists(userId, workspaceId),
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
  prompts,
  workspaces,
  runnerExecutables,
  generic,
);
let callbackServer: Bun.Server<undefined> | undefined;
const server = Bun.serve<QmushWebSocketData>({
  fetch(request, server) {
    if (isRealtimePath(request)) {
      return realtime.upgrade(request, server);
    }

    return handleRequest(request);
  },
  port: readQmushPort(Bun.env),
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
  clearInterval(vacuumTimer);
  if (freeSpace.timer !== undefined) {
    clearInterval(freeSpace.timer);
  }
  await sessions.drain();
  await Promise.all([server.stop(), callbackServer?.stop()]);
  writeResilience.close();
  database.$client.close();
}

process.on("SIGINT", () => {
  void shutDown();
});
process.on("SIGTERM", () => {
  void shutDown();
});

console.log(`Q Mush is running at ${server.url}`);
