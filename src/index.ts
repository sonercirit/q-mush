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
import { createRunnerIntegration } from "./runners.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  buildRunnerJavaScript,
  createRequestHandler,
} from "./server.ts";

const database = createDatabase(readDatabasePath(Bun.env));
const [clientJavaScript, runnerJavaScript, stylesheet] = await Promise.all([
  buildClientJavaScript(),
  buildRunnerJavaScript(),
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
const server = Bun.serve({
  fetch: createRequestHandler(
    clientJavaScript,
    stylesheet,
    googleAuth,
    openAi,
    openRouter,
    runners,
    runnerJavaScript,
  ),
});

if (usesOpenAiLoopbackCallback(Bun.env)) {
  try {
    const callbackServer = Bun.serve({
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

console.log(`Q Mush is running at ${server.url}`);
