import { createDatabase } from "../shared/database.ts";
import { readDatabasePath } from "../shared/database/config.ts";
import { createUuidV7 } from "../shared/ids.ts";
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
import { ProviderLimitStore } from "./provider-limit-store.ts";
import { ProviderLimitsService } from "./provider-limits-service.ts";
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

const database = createDatabase(readDatabasePath(Bun.env));
const [clientJavaScript, pages, runnerExecutables, stylesheet] =
  await Promise.all([
    buildClientJavaScript(),
    renderPages(),
    buildRunnerExecutableProvider(),
    buildClientStylesheet(),
  ]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env, { database });
const realtimeHub = new RealtimeHub();
const limits = new ProviderLimitsService(
  new ProviderLimitStore(database, createUuidV7),
  Date.now,
  realtimeHub,
);
const braveSearch = createBraveSearchSkillFromEnvironment(Bun.env, googleAuth, {
  database,
});
const openAi = createOpenAiIntegrationFromEnvironment(Bun.env, googleAuth, {
  database,
  limits,
});
const openRouter = createOpenRouterIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  { database, limits },
);
const runners = createRunnerIntegration(googleAuth, { database });
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { openai: openAi, openrouter: openRouter },
  { braveSearch, database, limits, realtime: realtimeHub },
);
const realtime = createRealtimeIntegration({
  auth: googleAuth,
  hub: realtimeHub,
  limits: (userId) => limits.snapshot(userId),
  runnerVersion: runnerExecutables.version,
  runners,
  sessions,
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
