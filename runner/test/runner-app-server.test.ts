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
