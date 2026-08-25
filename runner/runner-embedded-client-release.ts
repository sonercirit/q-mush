import { isRecord } from "../shared/auth-model.ts";
import { isSha256Digest } from "../shared/digest.ts";
import { sha256 } from "../shared/sha256.ts";
import type { RunnerAppRelease } from "./runner-app-server.ts";

export function embeddedClientRelease(
  value: string | undefined,
): RunnerAppRelease {
  if (value === undefined) {
    return { files: {}, shell: "<!doctype html><title>Q Mush</title>" };
  }
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("files" in parsed) ||
    !isRecord(parsed.files) ||
    !("shell" in parsed) ||
    typeof parsed.shell !== "string"
  ) {
    throw new Error("The embedded browser release is invalid");
  }
  const files = Object.entries(parsed.files);
  const manifestEncoded = parsed.files["manifest.json"];
  if (typeof manifestEncoded !== "string")
    throw new Error("The embedded browser release manifest is missing");
  const decoded = Object.fromEntries(
    files.map(([name, encoded]) => [
      name,
      Uint8Array.fromBase64(String(encoded)),
    ]),
  );
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(decoded["manifest.json"]),
  );
  if (!isRecord(manifest) || !isRecord(manifest["files"]))
    throw new Error("The embedded browser release manifest is invalid");
  const manifestFiles = manifest["files"];
  if (!isRecord(manifestFiles))
    throw new Error("The embedded browser release manifest is invalid");
  const manifestNames = Object.keys(manifestFiles);
  const decodedNames = Object.keys(decoded).filter(
    (name) => name !== "manifest.json",
  );
  if (
    manifestNames.length !== decodedNames.length ||
    decodedNames.some((name) => !Object.hasOwn(manifestFiles, name))
  )
    throw new Error(
      "The embedded browser release manifest file set is invalid",
    );
  for (const [name, digest] of Object.entries(manifestFiles)) {
    const bytes = decoded[name];
    if (
      !isSha256Digest(digest) ||
      bytes === undefined ||
      sha256(bytes) !== digest
    )
      throw new Error("The embedded browser release checksum is invalid");
  }
  return {
    files: decoded,
    shell: parsed.shell,
  };
}
