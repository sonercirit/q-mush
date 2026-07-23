import { expect, test } from "vitest";
import { buildClientJavaScript } from "../server.ts";

test("keeps service worker registration out of non-production builds", () =>
  expect(buildClientJavaScript()).resolves.toMatch(/enabled: false/u));
