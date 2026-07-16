import { describe, expect, test } from "bun:test";
import { createRequestHandler } from "../server.ts";

const clientJavaScript = 'document.querySelector("#app")?.replaceChildren();';
const handleRequest = createRequestHandler(clientJavaScript);

async function request(path: string): Promise<{
  readonly body: string;
  readonly response: Response;
}> {
  const response = handleRequest(new Request(`http://localhost${path}`));

  return { body: await response.text(), response };
}

describe("page server", () => {
  test("server renders the home page", async () => {
    const { body, response } = await request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(body).toStartWith("<!doctype html>");
    expect(body).toContain("<h1>Q Mush</h1>");
    expect(body).toContain('href="/app"');
    expect(body).not.toContain('src="/app.js"');
  });

  test("serves an empty app root for the client to render", async () => {
    const { body, response } = await request("/app?source=test");

    expect(response.status).toBe(200);
    expect(body).toContain('<main id="app"></main>');
    expect(body).toContain('<script src="/app.js" type="module"></script>');
    expect(body).not.toContain("<h1>Q Mush App</h1>");
  });

  test("serves the browser bundle", async () => {
    const { body, response } = await request("/app.js");

    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(body).toBe(clientJavaScript);
  });

  test("returns not found for unknown paths", async () => {
    const { body, response } = await request("/missing");

    expect(response.status).toBe(404);
    expect(body).toBe("Not found");
  });
});
