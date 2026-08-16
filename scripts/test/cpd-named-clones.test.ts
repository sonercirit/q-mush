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

function expectNoSourceClones(
  sources: Readonly<Record<string, string>>,
  minimums: { readonly lines: number; readonly tokens: number },
): Promise<void> {
  const { lines, tokens } = minimums;
  const prefix = "q-mush-cpd-no-clones-";
  return withTemporaryDirectory(prefix, (directory) =>
    writeSources(directory, sources).then((paths) => {
      expect(findNamedClones(directory, paths, lines, tokens)).toEqual([]);
    }),
  );
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

    const [clone] = clones;
    expect(clone?.tokens).toBe(37);
    expect([clone?.first.path, clone?.second.path]).toEqual([
      "first.ts",
      "second.ts",
    ]);
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

  test("uses JSX custom extensions and unambiguous TypeScript", async () => {
    const tsxClones = await findSourceClones(
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
    const genericClones = await findSourceClones(
      "q-mush-cpd-ts-generics-",
      {
        "first.ts": `function first() {
  const identity = <Value>(value: Value): Value => value;
  const primary = identity(1);
  return primary + identity(2);
}
`,
        "second.ts": `function second() {
  const convert = <Input>(input: Input): Input => input;
  const secondary = convert(1);
  return secondary + convert(2);
}
`,
      },
      1,
      20,
    );

    expect(tsxClones).toHaveLength(1);
    expect(genericClones).toHaveLength(1);
  });

  test("honors native CPD line and inclusive token boundaries", async () => {
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
      const oneLineClones = findNamedClones(directory, paths, 1, 1);
      expect(oneLineClones).toEqual([]);
      await writeSources(directory, {
        "first.ts": `function first(value: string) {
  return value.trim(); }
`,
        "second.ts": `function second(input: string) {
  return input.trim(); }
`,
      });
      expect(findNamedClones(directory, paths, 1, 1)).toHaveLength(1);
      expect(findNamedClones(directory, paths, 2, 1)).toEqual([]);
    });
  });

  test("uses native CPD token units at the configured boundary", async () => {
    await withTemporaryDirectory(
      "q-mush-cpd-token-units-",
      async (directory) => {
        const paths = await writeSources(directory, {
          "first.tsx": `export function first(value: string): string {
  return value.trim();
}
`,
          "second.tsx": `export function second(input: string): string {
  return input.trim();
}
`,
        });
        const replaceSources = (sources: readonly [string, string]) =>
          Promise.all(
            paths.map((path, index) =>
              writeFile(join(directory, path), sources[index] ?? ""),
            ),
          );
        const expectNativeTokenBoundary = (
          nativeTokens: number,
          expectedClones: number,
        ) => {
          expect(
            findNamedClones(directory, paths, 1, nativeTokens),
          ).toHaveLength(expectedClones);
        };

        expectNativeTokenBoundary(20, 0);
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
        expectNativeTokenBoundary(20, 0);
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
        expectNativeTokenBoundary(21, 0);
        await replaceSources([
          `function first(value: string) {
  return <><section>{value}</section><aside>{value}</aside></>;
}
`,
          `function second(input: string) {
  return <><section>{input}</section><aside>{input}</aside></>;
}
`,
        ]);
        expectNativeTokenBoundary(34, 1);
        await replaceSources([
          `function first(value: string) {
  const label = ` +
            "`prefix ${value}`" +
            `;
  const upper = value.trim().toUpperCase();
  return upper.concat(label).padStart(10, "0");
}
`,
          `function second(input: string) {
  const tag = ` +
            "`prefix ${input}`" +
            `;
  const transformed = input.trim().toUpperCase();
  return transformed.concat(tag).padStart(10, "0");
}
`,
        ]);
        expectNativeTokenBoundary(20, 1);
      },
    );
  });

  test("counts valid TypeScript generic arrows in native units", async () => {
    const minTokens = 29;
    const clones = await findSourceClones(
      "q-mush-cpd-generic-token-units-",
      {
        "first.ts": `function first() {
  const identity = <Value>(value: Value): Value => value;
  return identity(1);
}
`,
        "second.ts": `function second() {
  const convert = <Input>(input: Input): Input => input;
  return convert(1);
}
`,
      },
      1,
      minTokens,
    );

    expect(clones[0]?.tokens).toBe(minTokens);
  });

  test.each([
    ["plain", "<Value>", 29],
    ["comma-disambiguated", "<Value,>", 29],
    ["const", "<const Value>", 30],
    ["const comma-disambiguated", "<const Value,>", 30],
    ["const constrained", "<const Value extends number>", 31],
    ["const defaulted", "<const Value = number>", 31],
    ["constrained", "<Value extends number>", 30],
    ["defaulted", "<Value = number>", 30],
  ])(
    "counts %s generic arrows in native units",
    async (_label, typeParameter, nativeTokens) => {
      await withTemporaryDirectory("q-mush-cpd-generic-", async (directory) => {
        const paths = await writeSources(directory, {
          "first.ts": `function first() {
  const identity = ${typeParameter}(value: Value): Value => value;
  return identity(1);
}
`,
          "second.ts": `function second() {
  const convert = ${typeParameter.replaceAll("Value", "Input")}(input: Input): Input => input;
  return convert(1);
}
`,
        });
        const renamed = findNamedClones(directory, paths, 1, nativeTokens);
        const excluded = findNamedClones(directory, paths, 1, nativeTokens + 1);

        expect([renamed[0]?.tokens, excluded.length]).toEqual([
          nativeTokens,
          0,
        ]);
      });
    },
  );

  test("suppresses nested clones already covered by their parents", async () => {
    const clones = await findSourceClones("q-mush-cpd-nested-report-", {
      "first.ts": `function first(value: string) {
  function normalize(input: string) {
    return input.trim().toLowerCase().split("").reverse().join("");
  }
  return normalize(value);
}
`,
      "second.ts": `function second(source: string) {
  function transform(item: string) {
    return item.trim().toLowerCase().split("").reverse().join("");
  }
  return transform(source);
}
`,
    });

    expect(clones).toHaveLength(1);
    expect([clones[0]?.first.start.line, clones[0]?.second.start.line]).toEqual(
      [1, 1],
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

  test("normalizes object-rest bindings", async () => {
    const clones = await findSourceClones("q-mush-cpd-rest-", {
      "first.ts": `function first(source: Record<string, string>) {
  const { ...rest } = source;
  return Object.values(rest).join("").trim().toLowerCase();
}
`,
      "second.ts": `function second(input: Record<string, string>) {
  const { ...remaining } = input;
  return Object.values(remaining).join("").trim().toLowerCase();
}
`,
    });

    expect(clones).toHaveLength(1);
  });

  test.each([
    ["continue", "continue"],
    ["break", "break"],
  ])("normalizes statement labels and %s references", async (_label, jump) => {
    const clones = await findSourceClones("q-mush-cpd-labels-", {
      "first.ts": `function first(values: string[]) {
  outer: for (const value of values) {
    if (value.trim() === "") ${jump} outer;
    return value.trim().toLowerCase();
  }
  return "";
}
`,
      "second.ts": `function second(items: string[]) {
  scan: for (const item of items) {
    if (item.trim() === "") ${jump} scan;
    return item.trim().toLowerCase();
  }
  return "";
}
`,
    });

    expect(clones).toHaveLength(1);
  });

  test("keeps unresolved label spellings significant", async () => {
    await expectNoSourceClones(
      {
        "first.js": `function first(value) {
  if (value.trim() === "") break missing;
  return value.trim().toLowerCase();
}
`,
        "second.js": `function second(input) {
  if (input.trim() === "") break absent;
  return input.trim().toLowerCase();
}
`,
      },
      { lines: 1, tokens: 1 },
    );
  });

  test("keeps explicit and shorthand destructuring keys significant", async () => {
    const shorthandClones = await findSourceClones(
      "q-mush-cpd-destructuring-",
      {
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
      },
    );
    const explicitClones = await findSourceClones(
      "q-mush-cpd-explicit-destructuring-",
      {
        "first.ts": `function first(value: string) {
  const source = { alpha: value, beta: value };
  const { alpha: local } = source;
  return local.trim().toLowerCase().split("").reverse().join("");
}
`,
        "second.ts": `function second(input: string) {
  const source = { alpha: input, beta: input };
  const { beta: local } = source;
  return local.trim().toLowerCase().split("").reverse().join("");
}
`,
      },
    );

    expect(shorthandClones).toHaveLength(0);
    expect(explicitClones).toHaveLength(0);
  });

  test("keeps constructor parameter-property names significant", async () => {
    const clones = await findSourceClones(
      "q-mush-cpd-parameter-properties-",
      {
        "first.ts": `function first() {
  class Record { constructor(public alpha: string) {} }
  return Record;
}
`,
        "second.ts": `function second() {
  class Item { constructor(public beta: string) {} }
  return Item;
}
`,
      },
      1,
      20,
    );

    expect(clones).toHaveLength(0);
  });

  test("keeps qualified types significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-types-", {
      "first.ts": `function first(seed: string) {
  namespace Holder {
    export namespace Inner { export type Alpha = string; export type Beta = string; }
  }
  const value: Holder.Inner.Alpha = seed;
  return value.trim().toLowerCase().padStart(9, "0");
}
`,
      "second.ts": `function second(seed: string) {
  namespace Holder {
    export namespace Inner { export type Alpha = string; export type Beta = string; }
  }
  const value: Holder.Inner.Beta = seed;
  return value.trim().toLowerCase().padStart(9, "0");
}
`,
    });

    expect(clones).toHaveLength(0);
  });

  test.each([
    ["component", "Box", "alpha", "beta"],
    ["element", "div", "data-alpha", "data-beta"],
  ])(
    "keeps %s JSX attributes significant",
    async (_label, tag, firstAttribute, secondAttribute) => {
      const declarations =
        tag === "Box"
          ? "  const Box = (props: { alpha?: string; beta?: string }) => <i>{props.alpha ?? props.beta}</i>;\n"
          : "";
      const clones = await findSourceClones("q-mush-cpd-jsx-attributes-", {
        "first.tsx": `function first(seed: string) {
${declarations}  const value = seed.trim().toLowerCase();
  return <${tag} ${firstAttribute}={value}>{value.padStart(9, "0")}</${tag}>;
}
`,
        "second.tsx": `function second(seed: string) {
${declarations}  const value = seed.trim().toLowerCase();
  return <${tag} ${secondAttribute}={value}>{value.padStart(9, "0")}</${tag}>;
}
`,
      });

      expect(clones).toHaveLength(0);
    },
  );

  test("keeps local enum member names significant", async () => {
    const clones = await findSourceClones("q-mush-cpd-enum-members-", {
      "first.ts": `function first(seed: string) {
  enum Level { Alpha = 1, Beta = 2 }
  const names = Object.keys(Level).join("-");
  return names.concat(seed).trim().toLowerCase().padStart(9, "0");
}
`,
      "second.ts": `function second(seed: string) {
  enum Grade { Gamma = 1, Delta = 2 }
  const names = Object.keys(Grade).join("-");
  return names.concat(seed).trim().toLowerCase().padStart(9, "0");
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
