import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchRenderedPage } from "../../runner/page-fetch.ts";
import {
  observeRunnerRejection,
  requireRunnerError,
} from "./promise-test-helpers.ts";

const chromiumExecutable =
  process.env["Q_MUSH_CHROMIUM_EXECUTABLE"] ??
  [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((path) => Bun.file(path).size > 0);
const testWithChromium = chromiumExecutable === undefined ? test.skip : test;

let fixtureServer: ReturnType<typeof Bun.serve> | undefined;
let fixtureOrigin = "";
let fixtureDirectory = "";
let cookieWasSent = false;

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { headers: { location }, status: 302 });
}

function streamedHtmlResponse(byteCount: number): Response {
  const chunk = new Uint8Array(64 * 1_024).fill(97);
  let prefix = Buffer.from("<!doctype html><title>Oversized</title>");
  let remaining = byteCount;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (prefix.byteLength > 0) {
          const length = Math.min(chunk.byteLength, remaining);
          const first = new Uint8Array(prefix.byteLength + length);
          first.set(prefix);
          first.set(chunk.subarray(0, length), prefix.byteLength);
          prefix = Buffer.alloc(0);
          remaining -= length;
          controller.enqueue(first);
          return;
        }
        if (remaining === 0) {
          controller.close();
          return;
        }
        const length = Math.min(remaining, chunk.byteLength);
        remaining -= length;
        controller.enqueue(chunk.subarray(0, length));
      },
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function fixtureResponse(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/redirect") {
    return redirectResponse("/rendered");
  }

  if (url.pathname === "/redirect-chain") {
    const redirects = Number(url.searchParams.get("count") ?? "0");
    return redirectResponse(
      redirects <= 0
        ? "/rendered"
        : `/redirect-chain?count=${String(redirects - 1)}`,
    );
  }

  if (url.pathname === "/redirect-fragment") {
    return redirectResponse("/rendered#secret");
  }

  if (url.pathname === "/redirect-credentials") {
    return redirectResponse(
      `${url.protocol}//user:secret@${url.host}/rendered`,
    );
  }

  if (url.pathname === "/rendered") {
    return htmlResponse(
      `<!doctype html><html><head><title>SSR title</title><meta name="description" content="Rendered fixture"><meta property="og:type" content="article"></head><body><main><h1>Server text</h1><a href="/resolved?from=fixture">Resolved link</a><a href="https://user:secret@example.com/private">Credentialed link</a><a href="/fragment#secret">Fragment link</a><script>document.title = "Rendered title"; document.querySelector("h1").textContent = "JavaScript rendered text"; document.body.dataset.cookie = document.cookie || "isolated";</script></main></body></html>`,
    );
  }

  if (url.pathname === "/cookie") {
    cookieWasSent = request.headers.has("cookie");
    return new Response(
      `<!doctype html><title>Cookie</title><body>${cookieWasSent ? "cookie leaked" : "no cookie"}</body>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "fixture-secret=present; Path=/",
        },
      },
    );
  }

  if (url.pathname === "/binary") {
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  if (url.pathname === "/huge") {
    return htmlResponse(
      `<!doctype html><title>Huge</title><body>${"bounded text ".repeat(5_000)}</body>`,
    );
  }

  if (url.pathname === "/oversized") {
    return streamedHtmlResponse(17 * 1_024 * 1_024);
  }

  if (url.pathname === "/slow") {
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          htmlResponse("<!doctype html><title>Slow</title><body>late</body>"),
        );
      }, 5_000);
    });
  }

  return new Response("missing", { status: 404 });
}

async function fetchFixture(path: string): Promise<string> {
  return fetchRenderedPage(
    { timeout: 10, url: `${fixtureOrigin}${path}` },
    undefined,
    { executablePath: chromiumExecutable },
  );
}

async function profileArtifacts(): Promise<readonly string[]> {
  return (await readdir(tmpdir())).filter((name) =>
    name.startsWith("q-mush-page-fetch-"),
  );
}

async function waitForProfileCleanup(
  expected: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.stringify(await profileArtifacts()) === JSON.stringify(expected)) {
      return;
    }
    await Bun.sleep(10);
  }
  expect(await profileArtifacts()).toEqual(expected);
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "q-mush-page-fixture-"));
  fixtureServer = Bun.serve({
    fetch: fixtureResponse,
    idleTimeout: 30,
    port: 0,
  });
  fixtureOrigin = fixtureServer.url.origin;
});

afterAll(async () => {
  await fixtureServer?.stop(true);
  await rm(fixtureDirectory, { force: true, recursive: true });
});

describe("page fetch", () => {
  test("validates URL, timeout, and unavailable-browser configuration", async () => {
    for (const [arguments_, expected] of [
      [{ url: "file:///etc/passwd" }, "HTTP or HTTPS"],
      [{ url: "https://example.com/#fragment" }, "fragment"],
      [{ timeout: 0, url: "https://example.com" }, "timeout"],
      [{ timeout: 121, url: "https://example.com" }, "timeout"],
    ] as const) {
      const error = requireRunnerError(
        await observeRunnerRejection(
          fetchRenderedPage(arguments_, undefined, {
            executablePath: "/definitely/missing/chromium",
          }),
        ),
      );
      expect(error.message).toContain(expected);
    }

    const unavailable = requireRunnerError(
      await observeRunnerRejection(
        fetchRenderedPage({ url: "https://example.com" }, undefined, {
          executablePath: "/definitely/missing/chromium",
        }),
      ),
    );
    expect(unavailable.message).toContain("Chromium is unavailable");
    expect(unavailable.message).toContain("Q_MUSH_CHROMIUM_EXECUTABLE");
  });

  testWithChromium(
    "returns a bounded rendered page with final response data and resolved links",
    async () => {
      const beforeProfiles = await profileArtifacts();
      const output = await fetchFixture("/redirect");
      const result: unknown = JSON.parse(output);
      const resultText = JSON.stringify(result);

      expect(result).toMatchObject({
        finalUrl: `${fixtureOrigin}/rendered`,
        links: [
          {
            text: "Resolved link",
            url: `${fixtureOrigin}/resolved?from=fixture`,
          },
        ],
        metadata: {
          description: "Rendered fixture",
          openGraph: { type: "article" },
        },
        status: 200,
        text: "JavaScript rendered text\nResolved linkCredentialed linkFragment link",
        title: "Rendered title",
        truncated: {
          links: false,
          metadata: false,
          output: false,
          text: false,
        },
      });
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65_536);
      expect(resultText).not.toContain("user:secret");
      await waitForProfileCleanup(beforeProfiles);
    },
  );

  testWithChromium(
    "uses a fresh cookie-free profile for each page",
    async () => {
      await fetchFixture("/cookie");
      await fetchFixture("/cookie");

      expect(cookieWasSent).toBe(false);
    },
  );

  testWithChromium(
    "rejects unsafe redirects and excessive redirect chains",
    async () => {
      for (const [path, expected] of [
        ["/redirect-fragment", "redirected"],
        ["/redirect-credentials", "redirected"],
        ["/redirect-chain?count=11", "redirect limit"],
      ] as const) {
        const error = requireRunnerError(
          await observeRunnerRejection(fetchFixture(path)),
        );
        expect(error.message).toContain(expected);
      }
    },
  );

  testWithChromium(
    "rejects binary and oversized responses and bounds rendered output",
    async () => {
      const binaryError = requireRunnerError(
        await observeRunnerRejection(fetchFixture("/binary")),
      );
      expect(binaryError.message).toContain("HTML");

      const oversizedError = requireRunnerError(
        await observeRunnerRejection(fetchFixture("/oversized")),
      );
      expect(oversizedError.message).toContain("byte limit");

      const output = await fetchFixture("/huge");
      const result: unknown = JSON.parse(output);
      expect(result).toMatchObject({ truncated: { text: true } });
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65_536);
    },
  );

  testWithChromium("reports failed navigation clearly", async () => {
    const unavailableServer = Bun.serve({
      fetch: () => new Response("unused"),
      port: 0,
    });
    const url = unavailableServer.url.toString();
    await unavailableServer.stop(true);

    const error = requireRunnerError(
      await observeRunnerRejection(
        fetchRenderedPage({ timeout: 10, url }, undefined, {
          executablePath: chromiumExecutable,
        }),
      ),
    );
    expect(error.message).toContain("Page navigation failed");
  });

  testWithChromium("honors timeout and abort", async () => {
    const timedOut = requireRunnerError(
      await observeRunnerRejection(
        fetchRenderedPage(
          { timeout: 1, url: `${fixtureOrigin}/slow` },
          undefined,
          { executablePath: chromiumExecutable },
        ),
      ),
    );
    expect(timedOut.message).toContain("timed out");

    const controller = new AbortController();
    const pending = fetchRenderedPage(
      { timeout: 10, url: `${fixtureOrigin}/slow` },
      controller.signal,
      { executablePath: chromiumExecutable },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    const aborted = requireRunnerError(await observeRunnerRejection(pending));
    expect(aborted.message).toContain("stopped");
  });
});
