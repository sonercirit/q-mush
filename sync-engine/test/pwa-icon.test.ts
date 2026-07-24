import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createPwaIcon } from "../pwa-icon.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function chunks(png: Uint8Array): Map<string, Uint8Array> {
  expect(Buffer.from(png.slice(0, 8)).toString("hex")).toBe(PNG_SIGNATURE);
  const result = new Map<string, Uint8Array>();
  let offset = 8;

  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
    result.set(type, png.slice(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  return result;
}

function dimensions(png: Uint8Array): readonly [number, number] {
  const header = chunks(png).get("IHDR");
  if (header === undefined) {
    throw new Error("Missing PNG header");
  }
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  return [view.getUint32(0), view.getUint32(4)];
}

function pixel(
  png: Uint8Array,
  size: number,
  x: number,
  y: number,
): Uint8Array {
  const data = chunks(png).get("IDAT");
  if (data === undefined) {
    throw new Error("Missing PNG image data");
  }
  const pixels = inflateSync(data);
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  return pixels.subarray(offset, offset + 4);
}

describe("generated PWA icons", () => {
  test("are deterministic RGBA PNGs with the requested dimensions", () => {
    for (const size of [192, 512]) {
      const first = createPwaIcon(size);
      const second = createPwaIcon(size);

      expect(first).toEqual(second);
      expect(dimensions(first)).toEqual([size, size]);
      const header = chunks(first).get("IHDR");
      expect(header?.[8]).toBe(8);
      expect(header?.[9]).toBe(6);
    }
  });

  test("keeps maskable artwork inside the central safe zone", () => {
    const size = 512;
    const maskable = createPwaIcon(size, true);
    const background = pixel(maskable, size, 0, 0);

    for (const [x, y] of [
      [51, 256],
      [461, 256],
      [256, 51],
      [256, 461],
    ] as const) {
      expect(pixel(maskable, size, x, y)).toEqual(background);
    }
    expect(pixel(maskable, size, 256, 256)).not.toEqual(background);
  });

  test("rejects invalid dimensions", () => {
    expect(() => createPwaIcon(0)).toThrow("positive integer");
    expect(() => createPwaIcon(12.5)).toThrow("positive integer");
  });
});
