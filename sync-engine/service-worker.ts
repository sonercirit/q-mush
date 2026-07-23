import {
  APP_PATH,
  APP_SCRIPT_PATH,
  MANIFEST_PATH,
  PWA_ICON_192_PATH,
  PWA_ICON_512_MASKABLE_PATH,
  PWA_ICON_512_PATH,
  STYLESHEET_PATH,
} from "../shared/routes.ts";

const CACHE_PREFIX = "q-mush-shell-";
const VERSION_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const SHELL_PATHS = [
  APP_PATH,
  APP_SCRIPT_PATH,
  STYLESHEET_PATH,
  MANIFEST_PATH,
  PWA_ICON_192_PATH,
  PWA_ICON_512_PATH,
  PWA_ICON_512_MASKABLE_PATH,
] as const;

function serviceWorkerCacheName(version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("Invalid service worker version");
  }

  return `${CACHE_PREFIX}${version}`;
}

export function createServiceWorkerJavaScript(version: string): string {
  const cacheName = serviceWorkerCacheName(version);
  const shellPaths = JSON.stringify(SHELL_PATHS);

  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const APP_PATH = ${JSON.stringify(APP_PATH)};
const SHELL_PATHS = ${shellPaths};
const CACHEABLE_PATHS = new Set(SHELL_PATHS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableShellRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  return (
    url.origin === self.location.origin &&
    url.search === "" &&
    CACHEABLE_PATHS.has(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isCacheableShellRequest(request)) return;

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    if (url.pathname !== APP_PATH) return;
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match(APP_PATH)),
      ),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => cached ?? fetch(request)),
    ),
  );
});
`;
}
