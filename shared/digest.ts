export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/u.test(value);
}
