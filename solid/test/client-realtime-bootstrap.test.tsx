import { expect, test, vi } from "vitest";
import { startRealtimeSessionLoad } from "../../solid/session-transport.ts";

test("starts realtime before awaiting realtime-backed session loading", async () => {
  const loading = Promise.withResolvers<unknown>();
  const operations: string[] = [];
  const realtime = {
    start: vi.fn(() => {
      operations.push("start");
    }),
    stop: vi.fn(),
  };
  const result = startRealtimeSessionLoad(realtime, "workspace-1", () => {
    operations.push("load");
    return loading.promise;
  });

  expect(operations).toEqual(["start", "load"]);
  expect(realtime.start).toHaveBeenCalledExactlyOnceWith("workspace-1");
  loading.resolve("loaded");
  await expect(result).resolves.toBe("loaded");
  expect(realtime.stop).not.toHaveBeenCalled();
});

test("stops realtime when authenticated workspace loading fails", async () => {
  const realtime = { start: vi.fn(), stop: vi.fn() };
  const failure = new Error("load failed");

  await expect(
    startRealtimeSessionLoad(realtime, "workspace-1", () =>
      Promise.reject(failure),
    ),
  ).rejects.toBe(failure);

  expect(realtime.start).toHaveBeenCalledOnce();
  expect(realtime.stop).toHaveBeenCalledOnce();
});
