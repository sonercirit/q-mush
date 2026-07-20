import { afterEach, describe, expect, test } from "bun:test";
import { DirectoryPickerController } from "../directory-picker-controller.ts";
import { runnerDirectoriesPath } from "../routes.ts";
import { requestUrl } from "./controller-test-helpers.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("directory picker controller", () => {
  test("browses a runner and chooses its current directory", async () => {
    const requests: { readonly body: unknown; readonly url: string }[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          url,
        });
        return Promise.resolve(
          Response.json({
            directories: [{ name: "project", path: "/home/mush/project" }],
            parent: "/home",
            path: "/home/mush",
            truncated: false,
          }),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    let changes = 0;
    const controller = new DirectoryPickerController(() => {
      changes += 1;
    });

    await controller.open("runner/one", "~");

    expect(requests).toEqual([
      {
        body: { path: "~" },
        url: runnerDirectoriesPath("runner/one"),
      },
    ]);
    expect(controller.state).toMatchObject({
      error: undefined,
      listing: { path: "/home/mush" },
      loading: false,
      open: true,
      requestedPath: "~",
      runnerId: "runner/one",
    });
    expect(controller.choose()).toBe("/home/mush");
    expect(controller.state.open).toBeFalse();
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  test("keeps the picker open with a retryable error", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(new Response(null, { status: 409 })),
      { preconnect: originalFetch.preconnect },
    );
    const controller = new DirectoryPickerController(() => undefined);

    await controller.open("runner-1", "/missing");

    expect(controller.state).toMatchObject({
      error: "That runner is no longer available.",
      loading: false,
      open: true,
      requestedPath: "/missing",
    });
  });
});
