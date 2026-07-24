import { describe, expect, test } from "vitest";
import { buildClientAssets } from "../server.ts";

describe("service worker registration build flag", () => {
  test("keeps registration out of non-production server builds", async () => {
    const { javaScript } = await buildClientAssets(undefined);

    expect(javaScript).toMatch(/enabled: false/u);
  });

  test("enables registration in an explicit production server build", async () => {
    const { javaScript } = await buildClientAssets("production");

    expect(javaScript).toMatch(/enabled:[^,]*window\.isSecureContext/u);
    expect(javaScript).toContain("navigator.serviceWorker.register");
  });
});
