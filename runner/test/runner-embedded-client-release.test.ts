import { expect, test } from "vitest";
import { sha256 } from "../../shared/sha256.ts";
import { embeddedClientRelease } from "../runner-embedded-client-release.ts";

const encode = (value: Uint8Array | string): string =>
  (typeof value === "string"
    ? new TextEncoder().encode(value)
    : value
  ).toBase64();

test("embedded client release rejects an asset that does not match its manifest", () => {
  const expected = new TextEncoder().encode("expected asset");
  const release = JSON.stringify({
    files: {
      "app.abc.js": encode("tampered asset"),
      "manifest.json": encode(
        JSON.stringify({ files: { "app.abc.js": sha256(expected) } }),
      ),
    },
    shell: "shell",
  });
  expect(() => embeddedClientRelease(release)).toThrow("checksum");
});
