import { describe, expect, test, vi } from "vitest";
import { createQueryHost, queryHostForLocation } from "../query-host.ts";

describe("Solid query host", () => {
  test("selects the loopback runner and returns a labeled bounded partial view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ complete: true, records: [{ id: "session-1" }] }),
        ),
      ),
    );
    const host = queryHostForLocation({ hostname: "127.0.0.1" });
    expect(host.mutations).toBe(false);
    await expect(host.read("agent_sessions", { limit: 20 })).resolves.toEqual({
      complete: true,
      origin: "runner",
      partial: true,
      records: [{ id: "session-1" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/local/view?entity=agent_sessions&limit=20",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  test("rejects unbounded reads before contacting either host", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      createQueryHost("engine").read("agent_sessions", { limit: 101 }),
    ).rejects.toThrow("between 1 and 100");
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
