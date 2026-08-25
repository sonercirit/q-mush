import { describe, expect, test } from "vitest";
import { sha256 } from "../../shared/sha256.ts";
import { createRunnerAppHandler } from "../../runner/runner-app-server.ts";

const release = {
  files: {
    "app.abc.js": new TextEncoder().encode("console.log('app')"),
    "manifest.json": new TextEncoder().encode("{}"),
  },
  shell: "<!doctype html><title>Local Q Mush</title>",
};

describe("runner app server", () => {
  test("serves only loopback same-origin requests and immutable hashed assets", () => {
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127");
    const asset = handler(new Request("http://127.0.0.1:43127/app.abc.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(handler(new Request("http://evil.test/app.abc.js")).status).toBe(
      421,
    );
    expect(
      handler(
        new Request("http://127.0.0.1:43127/app.abc.js", {
          headers: { origin: "https://evil.test" },
        }),
      ).status,
    ).toBe(403);
  });

  test("rejects DNS-rebinding hosts and never grants cross-origin CORS", () => {
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127");
    const rebound = handler(
      new Request("http://attacker.test:43127/app.abc.js", {
        headers: { host: "127.0.0.1:43127" },
      }),
    );
    expect(rebound.status).toBe(421);
    expect(rebound.headers.has("access-control-allow-origin")).toBe(false);

    const preflight = handler(
      new Request("http://127.0.0.1:43127/api/local/status", {
        headers: {
          "access-control-request-method": "GET",
          origin: "https://attacker.test",
        },
        method: "OPTIONS",
      }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.has("access-control-allow-origin")).toBe(false);
  });

  test("serves paired replica blobs without cross-origin CORS", async () => {
    const bytes = new TextEncoder().encode("replica attachment");
    const digest = sha256(bytes);
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127", {
      pairing: { browserGrant: "grant", code: "code" },
      views: {
        progress: () => ({ state: "ready" }),
        readBlob: (requested) => {
          if (requested !== digest) throw new Error("missing");
          return new Blob([bytes], { type: "image/png" });
        },
        readView: () => ({ complete: true, partial: true, records: [] }),
      },
    });
    const response = handler(
      new Request(`http://127.0.0.1:43127/api/local/blob/${digest}`, {
        headers: { cookie: "qm_browser=grant" },
      }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  test("serves bounded read-only views without replica control endpoints", async () => {
    const views = {
      progress: () => ({ state: "ready" as const }),
      readView: () => ({
        complete: true as const,
        partial: true as const,
        records: [{ id: "session-1" }],
      }),
    };
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127", {
      pairing: { browserGrant: "grant", code: "code" },
      views,
    });
    const headers = { cookie: "qm_browser=grant" };
    const response = handler(
      new Request(
        "http://127.0.0.1:43127/api/local/view?entity=agent_sessions&limit=10",
        { headers },
      ),
    );
    expect(await response.json()).toEqual({
      complete: true,
      origin: "runner",
      partial: true,
      records: [{ id: "session-1" }],
    });
    expect(
      handler(
        new Request("http://127.0.0.1:43127/api/replica/ack", { headers }),
      ).status,
    ).toBe(404);
  });

  test("does not expose authentication or replica membership endpoints", () => {
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127");
    for (const path of [
      "/api/auth/session",
      "/api/replica/frontier",
      "/api/replica/ack",
    ]) {
      expect(handler(new Request(`http://127.0.0.1:43127${path}`)).status).toBe(
        404,
      );
    }
  });
});
