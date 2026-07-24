import { describe, expect, test } from "vitest";
import { truncateUtf8, utf8ByteLength } from "../../shared/utf8.ts";

describe("UTF-8 helpers", () => {
  test("counts encoded bytes", () => {
    expect(utf8ByteLength("aé😀")).toBe(7);
  });

  test("truncates only at complete code-point boundaries", () => {
    expect(truncateUtf8("é", 1)).toBe("");
    expect(truncateUtf8("😀", 3)).toBe("");
    expect(truncateUtf8("aé", 2)).toBe("a");
    expect(truncateUtf8("aé", 3)).toBe("aé");
  });
});
