import { createHash } from "node:crypto";

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/u.test(value);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
