import { createRoot } from "solid-js";
import { describe, expect, test } from "vitest";
import { runnerDirectoriesPath } from "../../shared/routes.ts";
import {
  createDirectoryPickerController,
  initialDirectoryPickerState,
} from "../../solid/directory-picker-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import {
  installRecordedRequestFetch,
  restoreFetchAfterEach,
} from "./controller-test-helpers.ts";

restoreFetchAfterEach();

describe("directory picker controller", () => {
  test("browses a runner and chooses its current directory", async () => {
    const recorded: {
      body: unknown;
      method: string;
      url: string;
    }[] = [];
    installRecordedRequestFetch(recorded, () =>
      Response.json({
        directories: [{ name: "project", path: "/home/mush/project" }],
        parent: "/home",
        path: "/home/mush",
        truncated: false,
      }),
    );
    const view = createReactiveState(initialDirectoryPickerState());
    const controller = createDirectoryPickerController(view);

    await controller.open("runner/one", "~");

    const requests = recorded.map(({ body, url }) => ({ body, url }));
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
    expect(controller.state.open).toBe(false);
  });

  test("keeps the picker open with a retryable error", async () => {
    globalThis.fetch = Object.assign(
      () => Promise.resolve(new Response(null, { status: 409 })),
      { preconnect: globalThis.fetch.preconnect },
    );
    const controller = createRoot(() => createDirectoryPickerController());

    await controller.open("runner-1", "/missing");

    expect(controller.state).toMatchObject({
      error: "That runner is no longer available.",
      loading: false,
      open: true,
      requestedPath: "/missing",
    });
  });
});
