import { createGoogleAuthFromEnvironment } from "./auth.ts";
import { createDatabase } from "./database.ts";
import { readDatabasePath } from "./database/config.ts";
import {
  createOpenAiIntegrationFromEnvironment,
  createOpenAiLoopbackCallbackHandler,
  OPENAI_LOOPBACK_CALLBACK_PORT,
  usesOpenAiLoopbackCallback,
} from "./openai.ts";
import { createOpenRouterIntegrationFromEnvironment } from "./openrouter.ts";
import { buildRunnerExecutableProvider } from "./runner-executable.ts";
import { createRunnerIntegration } from "./runners.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "./server.ts";
import { createSessionIntegration } from "./sessions.ts";

const database = createDatabase(readDatabasePath(Bun.env));
const [clientJavaScript, runnerExecutables, stylesheet] = await Promise.all([
  buildClientJavaScript(),
  buildRunnerExecutableProvider(),
  buildClientStylesheet(),
]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env, { database });
const openAi = createOpenAiIntegrationFromEnvironment(Bun.env, googleAuth, {
  database,
});
const openRouter = createOpenRouterIntegrationFromEnvironment(
  Bun.env,
  googleAuth,
  { database },
);
const runners = createRunnerIntegration(googleAuth, { database });
const sessions = createSessionIntegration(
  googleAuth,
  runners,
  { openai: openAi, openrouter: openRouter },
  { database },
);
let callbackServer: Bun.Server<undefined> | undefined;
const server = Bun.serve({
  fetch: createRequestHandler(
    clientJavaScript,
    stylesheet,
    googleAuth,
    openAi,
    openRouter,
    runners,
    sessions,
    runnerExecutables,
  ),
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
