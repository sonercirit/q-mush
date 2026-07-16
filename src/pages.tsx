import { createElement, renderToHtml, type JsxNode } from "./jsx.ts";
import { APP_PATH, APP_SCRIPT_PATH } from "./routes.ts";

function renderDocument(title: string, body: readonly JsxNode[]): string {
  const document = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>{body}</body>
    </html>
  );

  return `<!doctype html>${renderToHtml(document)}`;
}

export function renderHomePage(): string {
  return renderDocument("Q Mush", [
    <main>
      <h1>Q Mush</h1>
      <p>A local-first distributed agent swarm harness.</p>
      <a href={APP_PATH}>Open the app</a>
    </main>,
  ]);
}

export function renderAppPage(): string {
  return renderDocument("Q Mush App", [
    <main id="app"></main>,
    <script src={APP_SCRIPT_PATH} type="module"></script>,
    <noscript>
      The Q Mush app needs JavaScript because this page is rendered in the
      browser.
    </noscript>,
  ]);
}
