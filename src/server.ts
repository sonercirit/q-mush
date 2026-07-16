import { fileURLToPath } from "node:url";
import { renderAppPage, renderHomePage } from "./pages.tsx";
import {
  APP_PATH,
  APP_SCRIPT_PATH,
  HOME_PATH,
  STYLESHEET_PATH,
} from "./routes.ts";

const CSS_HEADERS = { "content-type": "text/css; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const JAVASCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
};
const TAILWIND_CLI_PATH = fileURLToPath(
  new URL(
    "dist/index.mjs",
    import.meta.resolve("@tailwindcss/cli/package.json"),
  ),
);

export function createRequestHandler(
  clientJavaScript: string,
  stylesheet: string,
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

    if (pathname === STYLESHEET_PATH) {
      return new Response(stylesheet, { headers: CSS_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  };
}

export async function buildClientStylesheet(): Promise<string> {
  const command = [
    process.execPath,
    TAILWIND_CLI_PATH,
    "--input",
    fileURLToPath(new URL("styles.css", import.meta.url)),
  ];

  if (Bun.env.NODE_ENV === "production") {
    command.push("--minify");
  }

  const buildProcess = Bun.spawn(command, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stylesheet, standardError] = await Promise.all([
    buildProcess.exited,
    new Response(buildProcess.stdout).text(),
    new Response(buildProcess.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Could not build the stylesheet:\n${standardError.trim()}`);
  }

  if (stylesheet.length === 0) {
    throw new Error("The stylesheet build did not produce CSS");
  }

  return stylesheet;
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
