import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findNamedClones } from "../cpd-named-clones.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

async function writeSources(
  directory: string,
  sources: Readonly<Record<string, string>>,
): Promise<string[]> {
  const paths = Object.keys(sources);
  await Promise.all(
    paths.map(async (path) => {
      const source = sources[path];
      if (source === undefined) {
        throw new Error(`Missing source for ${path}.`);
      }
      await writeFile(join(directory, path), source);
    }),
  );
  return paths;
}

describe("CPD named clone detection", () => {
  test("ignores function and parameter names", async () => {
    await withTemporaryDirectory("q-mush-cpd-names-", async (directory) => {
      const paths = await writeSources(directory, {
        "first.ts": `export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
        "second.ts": `export function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
`,
      });

      const clones = findNamedClones(directory, paths, 1, 20);

      expect(clones).toHaveLength(1);
      expect(clones[0]?.tokens).toBe(37);
      expect(clones[0]?.first.path).toBe("first.ts");
      expect(clones[0]?.second.path).toBe("second.ts");
    });
  });

  test("covers configured JavaScript extensions", async () => {
    await withTemporaryDirectory("q-mush-cpd-es-", async (directory) => {
      const paths = await writeSources(directory, {
        "first.es": `export function normalizeText(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.split("").reverse().join("");
}
`,
        "second.es6": `export function transformText(input) {
  const transformed = input.trim().toLowerCase();
  return transformed.split("").reverse().join("");
}
`,
      });

      expect(findNamedClones(directory, paths, 1, 20)).toHaveLength(1);
    });
  });

  test("keeps free project function names significant", async () => {
    await withTemporaryDirectory(
      "q-mush-cpd-free-names-",
      async (directory) => {
        const paths = await writeSources(directory, {
          "first.ts": `function trimText(value: string): string { return value.trim(); }
export function normalizeValue(input: string): string {
  const normalized = trimText(input);
  return normalized.toLowerCase().split("").reverse().join("");
}
`,
          "second.ts": `function encodeText(value: string): string { return encodeURIComponent(value); }
export function transformValue(source: string): string {
  const transformed = encodeText(source);
  return transformed.toLowerCase().split("").reverse().join("");
}
`,
        });

        expect(findNamedClones(directory, paths, 1, 20)).toEqual([]);
      },
    );
  });
});
