import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;
const GREEN = { blue: 131, green: 231, red: 110 } as const;
const CYAN = { blue: 211, green: 211, red: 34 } as const;
const DARK = { blue: 23, green: 6, red: 2 } as const;

interface Color {
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }

  return (crc ^ 0xffff_ffff) >>> 0;
}

function writeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const checksumInput = new Uint8Array(typeBytes.length + data.length);
  checksumInput.set(typeBytes);
  checksumInput.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(writeUint32(data.length));
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  chunk.set(writeUint32(crc32(checksumInput)), 8 + data.length);
  return chunk;
}

function blend(left: number, right: number, amount: number): number {
  return Math.round(left + (right - left) * amount);
}

function gradientColor(x: number, y: number, size: number): Color {
  const amount = (x + y) / Math.max(1, size * 2 - 2);
  return {
    blue: blend(GREEN.blue, CYAN.blue, amount),
    green: blend(GREEN.green, CYAN.green, amount),
    red: blend(GREEN.red, CYAN.red, amount),
  };
}

function isMushroomPixel(
  x: number,
  y: number,
  size: number,
  maskable: boolean,
): boolean {
  const scale = maskable ? 0.58 : 0.72;
  const center = size / 2;
  const localX = (x - center) / (size * scale);
  const localY = (y - center) / (size * scale);
  const cap =
    localY > -0.3 &&
    localY < 0.08 &&
    (localX * localX) / 0.24 + ((localY + 0.02) * (localY + 0.02)) / 0.1 < 1;
  const stem = Math.abs(localX) < 0.13 && localY >= 0.02 && localY < 0.36;
  return cap || stem;
}

function renderPixels(size: number, maskable: boolean): Uint8Array {
  const stride = size * 4 + 1;
  const pixels = new Uint8Array(stride * size);

  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const color = isMushroomPixel(x, y, size, maskable)
        ? gradientColor(x, y, size)
        : DARK;
      pixels[offset] = color.red;
      pixels[offset + 1] = color.green;
      pixels[offset + 2] = color.blue;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

export function createPwaIcon(size: number, maskable = false): Uint8Array {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("The PWA icon size must be a positive integer");
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, size);
  headerView.setUint32(4, size);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGBA;
  const chunks = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(renderPixels(size, maskable))),
    pngChunk("IEND", new Uint8Array()),
  ];
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const png = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }

  return png;
}
