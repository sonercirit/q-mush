import {
  APP_PATH,
  APP_SCRIPT_PATH,
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

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const responses = await Promise.all(
    SHELL_PATHS.map((path) =>
      fetch(path, {
        cache: "reload",
        credentials: "omit",
        redirect: "error",
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    const path = SHELL_PATHS[index];
    if (path === undefined) throw new TypeError("Invalid shell response");
    const expectedUrl = new URL(path, self.location.origin).href;
    if (
      !response.ok ||
      response.redirected ||
      response.type !== "basic" ||
      response.url !== expectedUrl
    ) {
      throw new TypeError("Uncacheable shell response");
    }
  }
  await Promise.all(
    responses.map((response, index) => {
      const path = SHELL_PATHS[index];
      if (path === undefined) throw new TypeError("Invalid shell response");
      return cache.put(path, response);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precacheShell()
      .then(() => self.skipWaiting())
      .catch((error) =>
        caches.delete(CACHE_NAME).then(() => {
          throw error;
        }),
      ),
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
  if (
    request.method !== "GET" ||
    request.cache === "no-store" ||
    (request.mode !== "navigate" && request.redirect !== "follow")
  ) {
    return false;
  }
  const url = new URL(request.url);
  return (
    url.origin === self.location.origin &&
    url.href === url.origin + url.pathname &&
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
      fetch(request).then(
        (response) => response,
        () =>
          caches.open(CACHE_NAME).then((cache) =>
            cache.match(APP_PATH).then((cached) => {
              if (cached === undefined) throw new TypeError("Offline shell unavailable");
              return cached;
            }),
          ),
      ),
    );
    return;
  }

  if (request.destination === "") return;
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => cached ?? fetch(request)),
    ),
  );
});
`;
}
