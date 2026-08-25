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
    typeof parsed.files !== "object" ||
    parsed.files === null ||
    !("shell" in parsed) ||
    typeof parsed.shell !== "string"
  ) {
    throw new Error("The embedded browser release is invalid");
  }
  const files = Object.entries(parsed.files);
  if (files.some((entry) => typeof entry[1] !== "string")) {
    throw new Error("The embedded browser release file is invalid");
  }
  return {
    files: Object.fromEntries(
      files.map(([name, encoded]) => [
        name,
        Uint8Array.fromBase64(String(encoded)),
      ]),
    ),
    shell: parsed.shell,
  };
}
