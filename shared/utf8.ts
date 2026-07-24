export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}
