export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }

  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }
  const accepted = bytes.subarray(0, end).toString("utf8");
  return accepted.endsWith("�") ? accepted.slice(0, -1) : accepted;
}
