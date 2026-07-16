import { fileURLToPath } from "node:url";
import { renderAppPage, renderHomePage } from "./pages.tsx";
import { APP_PATH, APP_SCRIPT_PATH, HOME_PATH } from "./routes.ts";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const JAVASCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
};

export function createRequestHandler(
  clientJavaScript: string,
): (request: Request) => Response {
  return (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === HOME_PATH) {
      return new Response(renderHomePage(), { headers: HTML_HEADERS });
    }

    if (pathname === APP_PATH) {
      return new Response(renderAppPage(), { headers: HTML_HEADERS });
    }

    if (pathname === APP_SCRIPT_PATH) {
      return new Response(clientJavaScript, { headers: JAVASCRIPT_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  };
}

export async function buildClientJavaScript(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("client.tsx", import.meta.url))],
    format: "esm",
    minify: Bun.env.NODE_ENV === "production",
    target: "browser",
  });

  if (!result.success) {
    const details = result.logs.map(({ message }) => message).join("\n");
    throw new Error(`Could not build the browser app:\n${details}`);
  }

  const output = result.outputs[0];

  if (output === undefined) {
    throw new Error("The browser build did not produce JavaScript");
  }

  return output.text();
}
