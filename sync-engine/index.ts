import { readDatabasePath } from "../shared/database/config.ts";
import { FINAL_SHUTDOWN_PREPARED_MESSAGE } from "../shared/development-shutdown.ts";
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
  recordDatabaseRetryFixtureEvent,
  startDatabaseRetryFixture,
} from "./database-write-resilience-fixture.ts";
import {
  DatabaseWriteResilience,
  installDatabaseWriteResilience,
  startDatabaseRecoveryWatcher,
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
import { createToolSettingsIntegration } from "./tool-settings.ts";

const databasePath = readDatabasePath(Bun.env);
const health = new EngineHealth();
const database = openDatabaseAndCleanupRepairSnapshots(databasePath, {
  health,
});
// Run the free-space preflight before the optional full VACUUM rebuild.
const vacuumRequiredBytes = databaseVacuumSafetyBytes(database.$client);
const freeSpace = startDatabaseFreeSpaceMonitor(
  databasePath,
  health,
  vacuumRequiredBytes,
);
const vacuum = enableIncrementalVacuum(database.$client, {
  availableBytes: freeSpace.availableBytes,
  minimumFreeBytes: freeSpace.minimumFreeBytes,
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
const toolSettings = createToolSettingsIntegration(googleAuth, {
  database,
  realtime: realtimeHub,
});
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { generic, openai: openAi, openrouter: openRouter },
  {
    braveSearch,
    database,
    realtime: realtimeHub,
    toolSettings: toolSettings.store,
    workspaces,
  },
);
const recoveryTimer = startDatabaseRecoveryWatcher(
  database.$client,
  health,
  () => sessions.reconcileDatabaseWrites(),
  () => sessions.hasPendingDatabaseWrites(),
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
const requestHandlerIntegrations = Object.freeze({
  googleAuth,
  braveSearch,
  generic,
  prompts,
  openAi,
  openRouter,
  runnerExecutables,
  runners,
  sessions,
  workspaces,
  toolSettings,
});
const handleRequest = createRequestHandler(
  clientJavaScript,
  stylesheet,
  pages,
  requestHandlerIntegrations,
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
  clearInterval(recoveryTimer);
  clearInterval(vacuumTimer);
  if (freeSpace.timer !== undefined) {
    clearInterval(freeSpace.timer);
  }
  await sessions.prepareFinalShutdown();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:prepared");
  process.send?.(FINAL_SHUTDOWN_PREPARED_MESSAGE);
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:acknowledged");
  await sessions.drain();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:drained");
  await Promise.all([server.stop(), callbackServer?.stop()]);
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:servers-closed");
  writeResilience.close();
  database.$client.close();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:database-closed");
}

process.on("SIGINT", () => {
  void shutDown();
});
process.on("SIGTERM", () => {
  void shutDown();
});
startDatabaseRetryFixture(database, health, Bun.env);

console.log(`Q Mush is running at ${server.url}`);
