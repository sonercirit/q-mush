import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { buildClientRelease } from "../../sync-engine/client-assets.ts";

describe("browser release", () => {
  test("produces content-addressed assets and a complete checksum manifest", async () => {
    const release = await buildClientRelease();
    const names = Object.keys(release.files);
    expect(names).toContain("manifest.json");
    expect(names.some((name) => /^app\.[a-f\d]{64}\.js$/u.test(name))).toBe(
      true,
    );
    expect(names.some((name) => /^styles\.[a-f\d]{64}\.css$/u.test(name))).toBe(
      true,
    );
    expect(release.manifest.files).toEqual(
      Object.fromEntries(
        Object.entries(release.files)
          .filter(([name]) => name !== "manifest.json")
          .map(([name, bytes]) => [
            name,
            createHash("sha256").update(bytes).digest("hex"),
          ]),
      ),
    );
  });
});
