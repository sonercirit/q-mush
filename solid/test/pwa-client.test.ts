import { describe, expect, test } from "vitest";
import {
  canOfferPwaInstall,
  isIosDevice,
  isStandalonePwa,
} from "../pwa-client.ts";

describe("PWA environment detection", () => {
  test("detects standalone and iOS installation states", () => {
    expect(isStandalonePwa({ matches: true }, false)).toBe(true);
    expect(isStandalonePwa({ matches: false }, true)).toBe(true);
    expect(isStandalonePwa({ matches: false }, false)).toBe(false);
    expect(isIosDevice("Mozilla/5.0 (iPhone)", 0)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Macintosh)", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (X11; Linux x86_64)", 0)).toBe(false);
  });

  test("offers installation only when actionable or useful", () => {
    expect(canOfferPwaInstall(false, false, false)).toBe(false);
    expect(canOfferPwaInstall(false, true, false)).toBe(true);
    expect(canOfferPwaInstall(false, false, true)).toBe(true);
    expect(canOfferPwaInstall(true, true, true)).toBe(false);
  });
});
