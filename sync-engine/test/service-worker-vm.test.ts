import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { APP_PATH } from "../../shared/routes.ts";
import { createServiceWorkerJavaScript } from "../service-worker.ts";

interface FetchEventLike {
  readonly request: RequestLike;
  readonly response: Promise<ResponseLike> | undefined;
}

interface RequestLike {
  readonly cache?: string;
  readonly credentials?: string;
  readonly destination?: string;
  readonly headers?: Headers;
  readonly method: string;
  readonly mode: string;
  readonly redirect?: string;
  readonly url: string;
}

interface ResponseLike {
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly type: string;
  readonly url: string;
  clone(): ResponseLike;
}

interface WorkerHarness {
  readonly cacheNames: readonly string[];
  readonly deletedCacheNames: readonly string[];
  readonly fetchCalls: readonly RequestLike[];
  readonly skipWaitingCalls: number;
  activate(): Promise<void>;
  dispatchFetch(request: RequestLike): FetchEventLike;
  install(): Promise<void>;
  response(body: Partial<ResponseLike>): ResponseLike;
}

function createWorkerHarness(
  options: {
    readonly initialCaches?: Readonly<
      Record<string, Readonly<Record<string, ResponseLike>>>
    >;
    readonly network?: (request: RequestLike) => Promise<ResponseLike>;
  } = {},
): WorkerHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, ResponseLike>>();
  const deletedCacheNames: string[] = [];
  const fetchCalls: RequestLike[] = [];
  let skipWaitingCalls = 0;

  for (const [name, entries] of Object.entries(options.initialCaches ?? {})) {
    stores.set(name, new Map(Object.entries(entries)));
  }

  const response = (
    body: Partial<ResponseLike> & { readonly url?: string },
  ): ResponseLike => {
    const value: ResponseLike = {
      clone: () => value,
      ok: body.ok ?? true,
      redirected: body.redirected ?? false,
      status: body.status ?? 200,
      type: body.type ?? "basic",
      url: body.url ?? "https://qmush.example/app",
    };
    return value;
  };
  const network =
    options.network ??
    ((request: RequestLike) => Promise.resolve(response({ url: request.url })));
  const openCache = (name: string) => {
    let store = stores.get(name);
    if (store === undefined) {
      store = new Map();
      stores.set(name, store);
    }
    return {
      match: (request: RequestLike | string) =>
        Promise.resolve(
          store.get(
            typeof request === "string"
              ? request
              : new URL(request.url).pathname,
          ),
        ),
      put: (path: string, value: ResponseLike) => {
        store.set(path, value);
        return Promise.resolve();
      },
    };
  };
  const context = {
    URL,
    caches: {
      delete: (name: string) => {
        deletedCacheNames.push(name);
        return Promise.resolve(stores.delete(name));
      },
      keys: () => Promise.resolve([...stores.keys()]),
      open: (name: string) => Promise.resolve(openCache(name)),
    },
    fetch: (request: RequestLike | string) => {
      const normalizedRequest =
        typeof request === "string"
          ? {
              cache: "reload",
              credentials: "omit",
              destination: "",
              method: "GET",
              mode: "cors",
              redirect: "error",
              url: `https://qmush.example${request}`,
            }
          : request;
      fetchCalls.push(normalizedRequest);
      return network(normalizedRequest);
    },
    self: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
      clients: { claim: () => Promise.resolve() },
      location: { origin: "https://qmush.example" },
      skipWaiting: () => {
        skipWaitingCalls += 1;
        return Promise.resolve();
      },
    },
  };
  runInNewContext(createServiceWorkerJavaScript("release-1"), context, {
    filename: "generated-service-worker.js",
  });

  const lifecycle = async (type: "activate" | "install"): Promise<void> => {
    let completion: Promise<unknown> | undefined;
    listeners.get(type)?.({
      waitUntil: (promise: Promise<unknown>) => {
        completion = promise;
      },
    });
    await completion;
  };

  return {
    activate: () => lifecycle("activate"),
    get cacheNames() {
      return [...stores.keys()];
    },
    deletedCacheNames,
    dispatchFetch(request) {
      let responsePromise: Promise<ResponseLike> | undefined;
      listeners.get("fetch")?.({
        request,
        respondWith: (value: Promise<ResponseLike>) => {
          responsePromise = value;
        },
      });
      return { request, response: responsePromise };
    },
    fetchCalls,
    install: () => lifecycle("install"),
    response,
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
  };
}

function request(
  path: string,
  options: { readonly method?: string; readonly mode?: string } = {},
): RequestLike {
  return {
    cache: "default",
    credentials: "include",
    destination: options.mode === "navigate" ? "document" : "script",
    method: options.method ?? "GET",
    mode: options.mode ?? "same-origin",
    redirect: "follow",
    url: new URL(path, "https://qmush.example").toString(),
  };
}

describe("generated service worker lifecycle", () => {
  test("accepts only direct 2xx same-origin allowlisted precache responses", async () => {
    for (const unsafe of [
      { redirected: true },
      { ok: false, status: 404 },
      { type: "opaque" },
      { url: "https://other.example/app" },
      { url: "https://qmush.example/app?" },
      { url: "https://qmush.example/api/auth/session" },
    ]) {
      let count = 0;
      const harness = createWorkerHarness({
        network: (request) => {
          count += 1;
          return Promise.resolve(
            harness.response({
              ...(count === 3 ? unsafe : {}),
              url:
                count === 3 && unsafe.url !== undefined
                  ? unsafe.url
                  : request.url,
            }),
          );
        },
      });

      await expect(harness.install()).rejects.toThrow("Uncacheable");
      expect(harness.skipWaitingCalls).toBe(0);
      expect(harness.cacheNames).toEqual([]);
    }
  });

  test("cleans only old Q Mush shell caches after a complete install", async () => {
    const harness = createWorkerHarness({
      initialCaches: {
        "q-mush-shell-old": {},
        "q-mush-unrelated": {},
        "third-party-cache": {},
      },
    });

    await harness.install();
    expect(
      harness.fetchCalls.every(({ credentials }) => credentials === "omit"),
    ).toBe(true);
    await harness.activate();

    expect(harness.skipWaitingCalls).toBe(1);
    expect(harness.deletedCacheNames).toEqual(["q-mush-shell-old"]);
    expect(harness.cacheNames).toContain("q-mush-shell-release-1");
    expect(harness.cacheNames).toContain("q-mush-unrelated");
    expect(harness.cacheNames).toContain("third-party-cache");
  });
});

describe("generated service worker fetch policy", () => {
  test("never intercepts private, ambiguous, or non-shell requests", () => {
    const harness = createWorkerHarness();
    const denied = [
      request("/api/auth/session"),
      request("/api/realtime"),
      request("/runner/executable"),
      request("/missing", { mode: "navigate" }),
      request("/app?session=private", { mode: "navigate" }),
      {
        method: "GET",
        mode: "navigate",
        url: "https://qmush.example/app?",
      },
      request("https://other.example/app", { mode: "navigate" }),
      request("/app", { method: "POST", mode: "navigate" }),
      request("/app.js", { mode: "navigate" }),
      { ...request("/app.js"), redirect: "manual" },
    ];

    for (const deniedRequest of denied) {
      expect(
        harness.dispatchFetch(deniedRequest).response,
        deniedRequest.url,
      ).toBeUndefined();
    }
    expect(harness.fetchCalls).toEqual([]);
  });

  test("falls back only for exact app navigation and never stores runtime responses", async () => {
    const cachedShell = createWorkerHarness().response({});
    const harness = createWorkerHarness({
      initialCaches: {
        "q-mush-shell-release-1": { [APP_PATH]: cachedShell },
      },
      network: () => Promise.reject(new TypeError("offline")),
    });

    const navigation = harness.dispatchFetch(
      request(APP_PATH, { mode: "navigate" }),
    );
    await expect(navigation.response).resolves.toBe(cachedShell);
    expect(harness.cacheNames).toEqual(["q-mush-shell-release-1"]);
  });

  test("does not serve a cached asset for a request with private request metadata", () => {
    const harness = createWorkerHarness();
    const privateRequest = {
      ...request("/app.js"),
      cache: "no-store",
      credentials: "include",
      headers: new Headers({ authorization: "Bearer private" }),
      redirect: "follow",
    };

    expect(harness.dispatchFetch(privateRequest).response).toBeUndefined();
  });
});
