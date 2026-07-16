import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "./server.ts";

const [clientJavaScript, stylesheet] = await Promise.all([
  buildClientJavaScript(),
  buildClientStylesheet(),
]);
const server = Bun.serve({
  fetch: createRequestHandler(clientJavaScript, stylesheet),
});

console.log(`Q Mush is running at ${server.url}`);
