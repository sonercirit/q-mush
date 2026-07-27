const UTF8_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }
  return UTF8_DECODER.decode(bytes.subarray(0, end));
}
