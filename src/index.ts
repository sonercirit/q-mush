import { buildClientJavaScript, createRequestHandler } from "./server.ts";

const clientJavaScript = await buildClientJavaScript();
const server = Bun.serve({ fetch: createRequestHandler(clientJavaScript) });

console.log(`Q Mush is running at ${server.url}`);
