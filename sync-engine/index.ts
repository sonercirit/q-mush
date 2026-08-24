import { readDatabasePath } from "../shared/database/config.ts";
import {
  DEVELOPMENT_RESTART_ESCALATE_MESSAGE,
  DEVELOPMENT_RESTART_PROGRESS_MESSAGE,
  DEVELOPMENT_RESTART_READY_MESSAGE,
  FINAL_SHUTDOWN_PREPARED_MESSAGE,
  FINAL_SHUTDOWN_REQUEST_MESSAGE,
  isDevelopmentRestartRequestMessage,
  RESTART_PROGRESS_INTERVAL_MS,
} from "../shared/development-shutdown.ts";
import { RestartDeadline } from "../shared/restart-deadline.ts";
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
  createDatabaseWriteResilience,
  installDatabaseWriteResilience,
  startDatabaseRecoveryWatcher,
} from "./database-write-resilience.ts";
import { createDevelopmentRestartLifecycle } from "./development-restart.ts";
import { createEngineHealth } from "./engine-health.ts";
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
import {
  addVisibleRestartSession,
  type RestartProgressVisibilityCache,
  restartProgressVisibilityKey,
  visibleRestartProgress,
} from "./restart-progress-visibility.ts";
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
const health = createEngineHealth();
const database = openDatabaseAndCleanupRepairSnapshots(databasePath, {
  health,
});
// Run the free-space preflight before the optional full VACUUM rebuild.
const vacuumRequiredBytes = databaseVacuumSafetyBytes(database.$client);
let freeSpace = startDatabaseFreeSpaceMonitor(
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
const writeResilience = createDatabaseWriteResilience({ health });
installDatabaseWriteResilience(database, writeResilience);
let vacuumTimer = startIncrementalVacuum(database.$client);
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
let recoveryTimer = startDatabaseRecoveryWatcher(
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
    console.warn(
      `OpenAI OAuth callback could not start: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const restartVisibleSessionIds: RestartProgressVisibilityCache = new Map();
sessions.onChange((userId, sessionId) => {
  if (!lifecycle.restarting) return;
  for (const workspaceId of realtimeHub.userWorkspaces(userId)) {
    if (sessions.detailForUser(userId, sessionId, workspaceId) === undefined) {
      continue;
    }
    addVisibleRestartSession(
      restartVisibleSessionIds,
      restartProgressVisibilityKey(userId, workspaceId),
      sessionId,
    );
  }
});

function startMaintenance(): void {
  const reconcileWrites = () => sessions.reconcileDatabaseWrites();
  const hasPendingWrites = () => sessions.hasPendingDatabaseWrites();
  recoveryTimer = startDatabaseRecoveryWatcher(
    database.$client,
    health,
    reconcileWrites,
    hasPendingWrites,
  );
  vacuumTimer = startIncrementalVacuum(database.$client);
  freeSpace = startDatabaseFreeSpaceMonitor(
    databasePath,
    health,
    vacuumRequiredBytes,
  );
}

function stopMaintenance(): void {
  clearInterval(recoveryTimer);
  clearInterval(vacuumTimer);
  if (freeSpace.timer !== undefined) {
    clearInterval(freeSpace.timer);
  }
}

function restartProgressMessage(
  progress: ReturnType<typeof sessions.drainProgress>,
) {
  return {
    progress,
    type: DEVELOPMENT_RESTART_PROGRESS_MESSAGE,
  } as const;
}

function publishRestartProgress(): void {
  const progress = sessions.drainProgress();
  const message = restartProgressMessage(progress);
  console.log(
    `Q Mush development restart is draining ${String(progress.length)} session(s)`,
  );
  process.send?.(message);
  for (const userId of realtimeHub.userIds()) {
    for (const workspaceId of realtimeHub.userWorkspaces(userId)) {
      const visibilityKey = restartProgressVisibilityKey(userId, workspaceId);
      const visibleProgress = visibleRestartProgress(
        restartVisibleSessionIds,
        visibilityKey,
        () => sessions.listForUser(userId, workspaceId).map(({ id }) => id),
        (sessionIds) =>
          progress.filter(({ sessionId }) => sessionIds.has(sessionId)),
      );
      realtimeHub.publishUser(
        userId,
        restartProgressMessage(visibleProgress),
        workspaceId,
      );
    }
  }
}

const restartProgressReporting = (() => {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start: () => {
      publishRestartProgress();
      timer = setInterval(publishRestartProgress, RESTART_PROGRESS_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
      restartVisibleSessionIds.clear();
    },
  };
})();

const lifecycle = createDevelopmentRestartLifecycle({
  drainFailed: (error) => {
    console.warn(
      `Q Mush development restart drain failed: ${errorMessage(error)}`,
    );
  },
  drainReady: () => {
    publishRestartProgress();
    process.send?.(DEVELOPMENT_RESTART_READY_MESSAGE);
  },
  drainSettled: restartProgressReporting.stop,
  drainStarted: restartProgressReporting.start,
  sessions,
  startMaintenance,
  stopMaintenance,
});

async function shutDown(): Promise<void> {
  if (!lifecycle.beginFinalShutdown()) {
    return;
  }

  await sessions.prepareFinalShutdown();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:prepared");
  process.send?.(FINAL_SHUTDOWN_PREPARED_MESSAGE);
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:acknowledged");
  await sessions.drainFinal();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:drained");
  await Promise.all([server.stop(), callbackServer?.stop()]);
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:servers-closed");
  writeResilience.close();
  database.$client.close();
  recordDatabaseRetryFixtureEvent(Bun.env, "shutdown:database-closed");
  if (process.connected) process.disconnect?.();
}

process.on("message", (message) => {
  if (isDevelopmentRestartRequestMessage(message)) {
    void lifecycle.restart(new RestartDeadline(message.deadlineAt));
  } else if (message === DEVELOPMENT_RESTART_ESCALATE_MESSAGE) {
    sessions.escalateDrain();
  } else if (message === FINAL_SHUTDOWN_REQUEST_MESSAGE) {
    void shutDown();
  }
});
process.on("SIGINT", () => {
  void shutDown();
});
process.on("SIGTERM", () => {
  void shutDown();
});
startDatabaseRetryFixture(database, health, Bun.env);

console.log(`Q Mush is running at ${server.url}`);
