import { createGoogleAuthFromEnvironment } from "./auth.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "./server.ts";

const [clientJavaScript, stylesheet] = await Promise.all([
  buildClientJavaScript(),
  buildClientStylesheet(),
]);
const googleAuth = createGoogleAuthFromEnvironment(Bun.env);
const server = Bun.serve({
  fetch: createRequestHandler(clientJavaScript, stylesheet, googleAuth),
});

console.log(`Q Mush is running at ${server.url}`);
