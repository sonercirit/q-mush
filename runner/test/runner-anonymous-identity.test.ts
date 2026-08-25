import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createAnonymousRunnerIdentity } from "../../runner/runner-anonymous-identity.ts";
import { createRunnerAppHandler } from "../../runner/runner-app-server.ts";

const release = {
  files: { "app.abc.js": new TextEncoder().encode("safe browser asset") },
  shell: "<!doctype html><title>Local Q Mush</title>",
};

const appOrigin = "http://127.0.0.1:43127";
const temporaryIdentity = (name: string) =>
  createAnonymousRunnerIdentity(mkdtempSync(join(tmpdir(), name)));
const pairedHandler = (identity: ReturnType<typeof temporaryIdentity>) =>
  createRunnerAppHandler(release, appOrigin, { pairing: identity.pairing });
const browserRequest = (path: string, cookie = "") =>
  new Request(`${appOrigin}${path}`, { headers: { cookie } });
const pairingRequest = (code: string, transcript: string) =>
  new Request(`${appOrigin}/api/local/pair`, {
    method: "POST",
    headers: {
      origin: appOrigin,
      "x-q-mush-pairing-code": code,
      "x-q-mush-pairing-transcript": transcript,
    },
  });

describe("anonymous runner genesis and browser pairing", () => {
  test("creates and reuses device-key account genesis without engine traffic", () => {
    const directory = mkdtempSync(join(tmpdir(), "q-mush-anonymous-"));
    const fetch = vi.spyOn(globalThis, "fetch");
    const first = createAnonymousRunnerIdentity(directory);
    const second = createAnonymousRunnerIdentity(directory);
    expect(second.publicIdentity).toEqual(first.publicIdentity);
    expect(first.publicIdentity.accountId).not.toMatch(/^qmr_/u);
    expect(first.publicIdentity.deviceId).not.toBe(
      first.publicIdentity.accountId,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(statSync(join(directory, "device-identity.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  test("requires a physical code and locks the grant to one browser", () => {
    const identity = temporaryIdentity("q-mush-pairing-");
    const handler = pairedHandler(identity);
    const initialStatus = handler(browserRequest("/app")).status;
    expect(initialStatus).toBe(200);
    expect(handler(browserRequest("/api/local/status")).status).toBe(401);
    const rejected = handler(
      pairingRequest("wrong-code", identity.pairing.transcript),
    );
    expect(rejected.status).toBe(403);
    const granted = handler(
      pairingRequest(identity.pairing.code, identity.pairing.transcript),
    );
    expect(granted.status).toBe(204);
    const cookie = granted.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(handler(browserRequest("/app", cookie ?? "")).status).toBe(200);
    expect(
      handler(
        pairingRequest(identity.pairing.code, identity.pairing.transcript),
      ).status,
    ).toBe(403);
    expect(handler(browserRequest("/unpaired-app")).status).toBe(401);
  });

  test("never gives the browser membership or device secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "q-mush-canary-"));
    const identity = createAnonymousRunnerIdentity(directory);
    const disk = readFileSync(join(directory, "device-identity.json"), "utf8");
    const hiddenApiRelease = {
      ...release,
      files: Object.fromEntries(
        [
          "api/replica/frontier",
          "api/replica/ack",
          "api/replica/readiness",
          "api/auth/session",
        ].map((name) => [name, new TextEncoder().encode("secret canary")]),
      ),
    };
    const handler = createRunnerAppHandler(hiddenApiRelease, appOrigin, {
      pairing: identity.pairing,
    });
    for (const path of [
      "/api/replica/frontier",
      "/api/replica/ack",
      "/api/replica/readiness",
      "/api/auth/session",
    ]) {
      expect(
        handler(
          browserRequest(path, `qm_browser=${identity.pairing.browserGrant}`),
        ).status,
      ).toBe(404);
    }
    const asset = await handler(
      browserRequest(
        "/app.abc.js",
        `qm_browser=${identity.pairing.browserGrant}`,
      ),
    ).text();
    for (const secret of [
      identity.pairing.code,
      identity.pairing.browserGrant,
    ]) {
      expect(disk).not.toContain(secret);
      expect(asset).not.toContain(secret);
    }
  });
});
