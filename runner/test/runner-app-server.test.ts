import { describe, expect, test } from "vitest";
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
