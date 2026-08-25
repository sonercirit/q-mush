export function decodeBase64(value: string): Uint8Array | undefined {
  try {
    return Uint8Array.fromBase64(value);
  } catch {
    return undefined;
  }
}
