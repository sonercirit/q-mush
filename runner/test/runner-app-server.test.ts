import { describe, expect, test } from "vitest";
import { createRunnerAppHandler } from "../../runner/runner-app-server.ts";
import { sha256 } from "../../shared/sha256.ts";

const pairing = {
  browserGrant: "grant",
  code: "code",
  expiresAt: Number.MAX_SAFE_INTEGER,
  transcript: "transcript",
};

const emptyView = () => ({
  complete: false,
  partial: true as const,
  records: [],
});

const release = {
  files: {
    "app.abc.js": new TextEncoder().encode("console.log('app')"),
    "manifest.json": new TextEncoder().encode("{}"),
  },
  shell: "<!doctype html><title>Local Q Mush</title>",
};

function pairedHandler(
  selectedRelease = release,
): ReturnType<typeof createRunnerAppHandler> {
  return createRunnerAppHandler(selectedRelease, "http://127.0.0.1:43127", {
    pairing,
  });
}

describe("runner app server", () => {
  test("serves only loopback same-origin requests and immutable hashed assets", () => {
    const handler = pairedHandler();
    const asset = handler(
      new Request("http://127.0.0.1:43127/app.abc.js", {
        headers: { cookie: "qm_browser=grant" },
      }),
    );
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
    const handler = pairedHandler();
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

  test("serves the pairing shell before granting API access", async () => {
    const handler = pairedHandler();
    const shell = handler(new Request("http://127.0.0.1:43127/app"));
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Local Q Mush");
    expect(
      handler(
        new Request("http://127.0.0.1:43127/api/local/view", {
          method: "POST",
        }),
      ).status,
    ).toBe(401);
    expect(
      handler(new Request("http://127.0.0.1:43127/api/local/status")).status,
    ).toBe(401);
  });

  test("exposes persisted retry progress to a paired browser", async () => {
    const handler = createRunnerAppHandler(release, "http://127.0.0.1:43127", {
      pairing,
      views: {
        progress: () => ({
          elapsedMilliseconds: 123,
          previousRevision: "old",
          records: 0,
          restartCount: 2,
          revision: "new",
          state: "joining",
          tombstones: 0,
        }),
        readView: emptyView,
      },
    });
    const response = handler(
      new Request("http://127.0.0.1:43127/api/local/status", {
        headers: { cookie: "qm_browser=grant" },
      }),
    );
    expect(await response.json()).toMatchObject({
      retry: {
        elapsedMilliseconds: 123,
        previousRevision: "old",
        restartCount: 2,
        revision: "new",
      },
    });
  });

  test("serves paired replica blobs without cross-origin CORS", async () => {
    const bytes = new TextEncoder().encode("replica attachment");
    const digest = sha256(bytes);
    const localOrigin = "http://127.0.0.1:43127";
    const handler = createRunnerAppHandler(release, localOrigin, {
      pairing,
      views: {
        progress: () => ({ state: "ready" }),
        readBlob: (requested) => {
          if (requested !== digest) throw new Error("missing");
          return new Blob([bytes], { type: "image/png" });
        },
        readView: emptyView,
      },
    });
    const response = handler(
      new Request(`http://127.0.0.1:43127/api/local/blob/${digest}`, {
        headers: { cookie: "qm_browser=grant" },
      }),
    );
    expect(
      handler(
        new Request("http://127.0.0.1:43127/api/local/blob/not-a-digest", {
          headers: { cookie: "qm_browser=grant" },
        }),
      ).status,
    ).toBe(400);
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
      pairing,
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
        new Request("http://127.0.0.1:43127/api/local/view", {
          headers,
          method: "POST",
        }),
      ).status,
    ).toBe(405);
    expect(
      handler(
        new Request("http://127.0.0.1:43127/api/replica/ack", { headers }),
      ).status,
    ).toBe(404);
  });

  test("expires pairing challenges and locks out after five failures", () => {
    const expired = { ...pairing, expiresAt: Date.now() - 1 };
    expect(
      createRunnerAppHandler(release, "http://127.0.0.1:43127", {
        pairing: expired,
      })(
        new Request("http://127.0.0.1:43127/api/local/pair", {
          headers: {
            "x-q-mush-pairing-code": pairing.code,
            "x-q-mush-pairing-transcript": pairing.transcript,
          },
          method: "POST",
        }),
      ).status,
    ).toBe(403);
    const handler = pairedHandler();
    const attempt = (code: string) =>
      handler(
        new Request("http://127.0.0.1:43127/api/local/pair", {
          headers: {
            "x-q-mush-pairing-code": code,
            "x-q-mush-pairing-transcript": pairing.transcript,
          },
          method: "POST",
        }),
      );
    for (let index = 0; index < 5; index += 1)
      expect(attempt("wrong").status).toBe(403);
    expect(attempt(pairing.code).status).toBe(403);
  });

  test("rejects prototype-key release files", () => {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {
      ["__proto__"]: new TextEncoder().encode("unsafe"),
    };
    Object.setPrototypeOf(files, null);
    const handler = pairedHandler({ files, shell: release.shell });
    const response = handler(
      new Request("http://127.0.0.1:43127/__proto__", {
        headers: new Headers({ cookie: "qm_browser=grant" }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("does not expose authentication or replica membership endpoints", async () => {
    const hiddenApiRelease = {
      ...release,
      files: {
        ...release.files,
        "api/auth/session": new TextEncoder().encode("asset canary"),
        "api/replica/ack": new TextEncoder().encode("asset canary"),
        "api/replica/frontier": new TextEncoder().encode("asset canary"),
      },
    };
    const handler = pairedHandler(hiddenApiRelease);
    for (const path of [
      "/api/auth/session",
      "/api/replica/frontier",
      "/api/replica/ack",
    ]) {
      const response = handler(
        new Request(`http://127.0.0.1:43127${path}`, {
          headers: { cookie: "qm_browser=grant" },
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });
});
