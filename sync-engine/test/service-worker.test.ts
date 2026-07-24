import { describe, expect, test } from "vitest";
import { API_BASE_PATH, APP_PATH } from "../../shared/routes.ts";
import { createServiceWorkerJavaScript } from "../service-worker.ts";

function source(version = "release-1"): string {
  return createServiceWorkerJavaScript(version);
}

describe("PWA cache policy", () => {
  test("uses only an explicit same-origin GET app-shell allowlist", () => {
    const worker = source();

    for (const path of [
      APP_PATH,
      "/app.js",
      "/styles.css",
      "/icons/q-mush-192.png",
      "/icons/q-mush-512.png",
      "/icons/q-mush-maskable-512.png",
    ]) {
      expect(worker).toContain(JSON.stringify(path));
    }
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).toContain('request.cache === "no-store"');
    expect(worker).toContain('redirect: "error"');
    expect(worker).toContain('credentials: "omit"');
    expect(worker).toContain("response.redirected");
    expect(worker).toContain('response.type !== "basic"');
    expect(worker).toContain("response.url !== expectedUrl");
    expect(worker).toContain("cache.put(path, response)");
    expect(worker).not.toContain("cache.addAll");
    expect(worker).toContain("url.origin === self.location.origin");
    expect(worker).toContain("url.href === url.origin + url.pathname");
    expect(worker).toContain("CACHEABLE_PATHS.has(url.pathname)");
    expect(worker).not.toContain('"/manifest.webmanifest"');
  });

  test("does not name authenticated or arbitrary resources", () => {
    const worker = source();
    const deniedFragments = [
      `${API_BASE_PATH}/`,
      "auth/session",
      "oauth",
      "realtime",
      "sessions/",
      "runner/install",
      "runner/executable",
      "transcript",
      "remote",
    ];

    for (const fragment of deniedFragments) {
      expect(worker).not.toContain(fragment);
    }
  });
});

test("builds a versioned service worker with safe fallback and cleanup", () => {
  const worker = source();

  expect(worker).toContain('const CACHE_NAME = "q-mush-shell-release-1"');
  expect(worker).toContain('const APP_PATH = "/app"');
  expect(worker).toContain("url.pathname !== APP_PATH");
  expect(worker).toContain("cache.match(APP_PATH)");
  expect(worker).toContain("caches.delete(name)");
  expect(worker).toContain("self.skipWaiting()");
  expect(worker).toContain("self.clients.claim()");
});

test("rejects unsafe service worker version values", () => {
  expect(() => source('bad"\nvalue')).toThrow("Invalid service worker version");
  expect(() => source("")).toThrow("Invalid service worker version");
});
