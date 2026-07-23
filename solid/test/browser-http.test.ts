import { expect, test } from "vitest";
import { request, requestJson } from "../browser-http.ts";

const calls: RequestInit[] = [];
let originalFetch: typeof globalThis.fetch;

function useResponse(response: Response): void {
  originalFetch = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(response.clone());
    },
    { preconnect: originalFetch.preconnect },
  );
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

test("browser API requests bypass HTTP caches", async () => {
  useResponse(Response.json({ ok: true }));
  try {
    await requestJson("/api/auth/session");
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    restoreFetch();
  }

  expect(calls).toHaveLength(2);
  expect(calls.every(({ cache }) => cache === "no-store")).toBe(true);
});

test("preserves an explicitly stricter caller cache mode", async () => {
  useResponse(new Response(null, { status: 204 }));
  try {
    await request("/api/example", { cache: "reload" });
  } finally {
    restoreFetch();
  }

  expect(calls[0]?.cache).toBe("reload");
});
