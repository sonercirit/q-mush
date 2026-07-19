import { createGoogleAuthFromEnvironment } from "./auth.ts";
import { createDatabase } from "./database.ts";
import { readDatabasePath } from "./database/config.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "./server.ts";

const database = createDatabase(readDatabasePath(Bun.env));
const [clientJavaScript, stylesheet] = await Promise.all([
  buildClientJavaScript(),
  buildClientStylesheet(),
]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env, { database });
const server = Bun.serve({
  fetch: createRequestHandler(clientJavaScript, stylesheet, googleAuth),
});

console.log(`Q Mush is running at ${server.url}`);
