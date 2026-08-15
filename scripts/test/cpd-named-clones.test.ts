import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findNamedClones, formatNamedClones } from "../cpd-named-clones.ts";
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

async function findSourceClones(
  prefix: string,
  sources: Readonly<Record<string, string>>,
  minLines = 1,
  minTokens = 20,
) {
  return withTemporaryDirectory(prefix, async (directory) => {
    const paths = await writeSources(directory, sources);
    return findNamedClones(directory, paths, minLines, minTokens);
  });
}

const RENAMED_SOURCES = {
  "first.ts": `function first(value: string) {
  return value.trim();
}
`,
  "second.ts": `function second(input: string) {
  return input.trim();
}
`,
} as const;

describe("CPD named clone detection", () => {
  test("ignores function and parameter names", async () => {
    const clones = await findSourceClones("q-mush-cpd-names-", {
      "first.ts": `export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
      "second.ts": `export function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
`,
    });

    expect(clones).toHaveLength(1);
    expect(clones[0]?.tokens).toBe(37);
    expect(clones[0]?.first.path).toBe("first.ts");
    expect(clones[0]?.second.path).toBe("second.ts");
  });

  test("covers configured JavaScript extensions", async () => {
    const clones = await findSourceClones("q-mush-cpd-es-", {
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

    expect(clones).toHaveLength(1);
  });

  test("parses configured nonstandard extensions as TSX", async () => {
    const clones = await findSourceClones(
      "q-mush-cpd-es-tsx-",
      {
        "first.es": `function first(value) {
  return <><section>{value}</section><aside>{value}</aside></>;
}
`,
        "second.es6": `function second(input) {
  return <><section>{input}</section><aside>{input}</aside></>;
}
`,
      },
      1,
      20,
    );

    expect(clones).toHaveLength(1);
  });

  test("honors native CPD line spans and inclusive token thresholds", async () => {
    await withTemporaryDirectory("q-mush-cpd-limits-", async (directory) => {
      const paths = await writeSources(directory, {
        "first.ts": "function first(value: string) { return value.trim(); }\n",
        "second.ts":
          "function second(input: string) { return input.trim(); }\n",
      });

      const clone = findNamedClones(directory, paths, 0, 1)[0];

      expect(clone).toBeDefined();
      expect(
        findNamedClones(directory, paths, 0, clone?.tokens ?? 1),
      ).toHaveLength(1);
      expect(findNamedClones(directory, paths, 1, 1)).toEqual([]);
    });
  });

  test("uses native CPD token units at the configured boundary", async () => {
    await withTemporaryDirectory(
      "q-mush-cpd-token-units-",
      async (directory) => {
        const paths = await writeSources(directory, {
          "first.ts": `export function first(value: string): string {
  return value.trim();
}
`,
          "second.ts": `export function second(input: string): string {
  return input.trim();
}
`,
        });

        const tokenThresholdClones = findNamedClones(directory, paths, 1, 20);
        expect(tokenThresholdClones).toEqual([]);
        const replaceSources = (sources: readonly [string, string]) =>
          Promise.all(
            paths.map((path, index) =>
              writeFile(join(directory, path), sources[index] ?? ""),
            ),
          );
        await replaceSources([
          `function first(value: string): boolean {
  return /a+b?/giu.test(value);
}
`,
          `function second(input: string): boolean {
  return /a+b?/giu.test(input);
}
`,
        ]);
        const compoundTokenClones = findNamedClones(directory, paths, 1, 20);
        expect(compoundTokenClones).toEqual([]);
        await replaceSources([
          `function first(left: number, right: number): number {
  return left >>> right;
}
`,
          `function second(value: number, shift: number): number {
  return value >>> shift;
}
`,
        ]);
        const shiftTokenClones = findNamedClones(directory, paths, 1, 21);
        expect(shiftTokenClones).toEqual([]);
      },
    );
  });

  test("reports a deterministic first renamed pair", async () => {
    const clones = await findSourceClones(
      "q-mush-cpd-order-",
      {
        ...RENAMED_SOURCES,
        "third.ts": `function third(source: string) {
  return source.trim();
}
`,
      },
      1,
      1,
    );

    expect(clones).toHaveLength(2);
    expect(clones.map((clone) => clone.second.path)).toEqual([
      "second.ts",
      "third.ts",
    ]);
    expect(formatNamedClones(clones)).toContain(
      "Found 2 clones with renamed local bindings.",
    );
  });

  test("inherits compiler options from extended tsconfig files", async () => {
    await withTemporaryDirectory("q-mush-cpd-tsconfig-", async (directory) => {
      await writeSources(directory, {
        "base.json": JSON.stringify({ compilerOptions: { jsx: "preserve" } }),
        "first.tsx": `function first(value: string) {
  return <span>{value.trim()}</span>;
}
`,
        "second.tsx": `function second(input: string) {
  return <span>{input.trim()}</span>;
}
`,
        "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      });

      expect(
        findNamedClones(directory, ["first.tsx", "second.tsx"], 1, 1),
      ).toHaveLength(1);
    });
  });

  test("reports every malformed source with deterministic locations", async () => {
    await withTemporaryDirectory("q-mush-cpd-invalid-", async (directory) => {
      const paths = await writeSources(directory, {
        "first.ts": "export function first( { return 1; }\n",
        "second.ts": "export function second( { return 2; }\n",
      });

      expect(() => findNamedClones(directory, paths, 1, 1)).toThrow(
        new RegExp(
          "TypeScript could not analyze CPD sources:\\n" +
            ".*first\\.ts:1:33 - ':' expected\\.[\\s\\S]*" +
            ".*second\\.ts:1:34 - ':' expected\\.",
          "u",
        ),
      );
    });
  });

  test("keeps member APIs and literals significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-members-", {
      "first.ts": `export function first(value: { left: string }) {
  const normalized = value.left.trim().toLowerCase();
  return normalized.split("").reverse().join("");
}
`,
      "second.ts": `export function second(input: { right: string }) {
  const transformed = input.right.trim().toUpperCase();
  return transformed.split("").reverse().join("");
}
`,
    });

    expect(clones).toHaveLength(0);
  });

  test("keeps object properties and their accesses significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-properties-", {
      "first.ts": `function first(value: string) {
  const record = { alpha: value.trim().toLowerCase() };
  return record.alpha.split("").reverse().join("");
}
`,
      "second.ts": `function second(input: string) {
  const item = { beta: input.trim().toLowerCase() };
  return item.beta.split("").reverse().join("");
}
`,
    });

    expect(clones).toHaveLength(0);
  });

  test("keeps local class member APIs significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-class-members-", {
      "first.ts": `function first(value: string) {
  class Record { alpha = value.trim().toLowerCase(); }
  return new Record().alpha.split("").reverse().join("");
}
`,
      "second.ts": `function second(input: string) {
  class Item { beta = input.trim().toLowerCase(); }
  return new Item().beta.split("").reverse().join("");
}
`,
    });

    expect(clones).toHaveLength(0);
  });

  test("keeps shorthand and method property names significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-shorthand-", {
      "first.ts": `const first = {
  alpha(value: string) {
    const normalized = value.trim().toLowerCase();
    return { normalized };
  },
};
`,
      "second.ts": `const second = {
  beta(input: string) {
    const transformed = input.trim().toLowerCase();
    return { transformed };
  },
};
`,
    });

    expect(clones).toEqual([]);
  });

  test("keeps shorthand destructuring keys significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-destructuring-", {
      "first.ts": `function first(source: Record<string, string>) {
  const { alpha } = source;
  return alpha.trim().toLowerCase().split("").reverse().join("");
}
`,
      "second.ts": `function second(input: Record<string, string>) {
  const { beta } = input;
  return beta.trim().toLowerCase().split("").reverse().join("");
}
`,
    });

    expect(clones).toHaveLength(0);
  });

  test("keeps free project function names significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-free-names-", {
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

    expect(clones).toEqual([]);
  });
});
