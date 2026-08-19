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
import {
  addVisibleRestartSession,
  type RestartProgressVisibilityCache,
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
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { generic, openai: openAi, openrouter: openRouter },
  { braveSearch, database, realtime: realtimeHub, workspaces },
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
    console.warn(
      `OpenAI OAuth callback could not start: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let shutdownKind: "development_restart" | "final" | undefined;
let developmentRestart: Promise<void> | undefined;
const restartVisibleSessionIds: RestartProgressVisibilityCache = new Map();
sessions.onChange((userId, sessionId) => {
  if (shutdownKind !== "development_restart") return;
  for (const workspaceId of realtimeHub.userWorkspaces(userId)) {
    if (sessions.detailForUser(userId, sessionId, workspaceId) === undefined) {
      continue;
    }
    addVisibleRestartSession(
      restartVisibleSessionIds,
      `${userId}\0${workspaceId}`,
      sessionId,
    );
  }
});

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
      const visibilityKey = `${userId}\0${workspaceId}`;
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

function restartDevelopment(deadlineAt = Date.now()): Promise<void> {
  if (shutdownKind === "final") {
    return Promise.resolve();
  }
  if (developmentRestart !== undefined) {
    sessions.escalateDrain();
    return developmentRestart;
  }

  shutdownKind = "development_restart";
  stopMaintenance();
  publishRestartProgress();
  const progressTimer = setInterval(
    publishRestartProgress,
    RESTART_PROGRESS_INTERVAL_MS,
  );
  progressTimer.unref();
  const deadline = new RestartDeadline(deadlineAt);
  developmentRestart = sessions
    .drain(deadline)
    .catch((error: unknown) => {
      console.warn(
        `Q Mush development restart drain failed: ${errorMessage(error)}`,
      );
    })
    .then(() => {
      publishRestartProgress();
      process.send?.(DEVELOPMENT_RESTART_READY_MESSAGE);
    })
    .finally(() => {
      clearInterval(progressTimer);
      restartVisibleSessionIds.clear();
    });
  return developmentRestart;
}

async function shutDown(): Promise<void> {
  if (shutdownKind === "final") {
    return;
  }

  shutdownKind = "final";
  stopMaintenance();
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
    void restartDevelopment(message.deadlineAt);
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
