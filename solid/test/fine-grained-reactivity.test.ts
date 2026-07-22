import { expect, test } from "vitest";

const CLIENT_ARCHITECTURE_FILES = [
  "solid/client.tsx",
  "solid/provider-controller.ts",
  "solid/runner-controller.ts",
  "solid/session-controller.ts",
] as const;

const REMOUNT_RESTORATION_MARKERS = [
  "data-focus-key",
  "data-scroll-key",
  "data-scroll-on-change",
  "data-scroll-revision",
] as const;

async function readProjectFile(path: string): Promise<string> {
  return Bun.file(new URL(`../../${path}`, import.meta.url)).text();
}

test("the browser app uses one reactive Solid root with declarative UI events", async () => {
  const [client = "", ...controllers] = await Promise.all(
    CLIENT_ARCHITECTURE_FILES.map(readProjectFile),
  );

  expect(client.match(/\brender\s*\(/gu)).toHaveLength(1);
  expect(client).not.toMatch(/\bupdateApp\b/u);
  expect(client).not.toMatch(/\bdisposeApp\b/u);
  expect(client).toMatch(/\bcreateSignal\s*\(/u);
  expect(client).toMatch(/\bonMount\s*\(/u);

  for (const source of [client, ...controllers]) {
    expect(source).not.toMatch(/\.querySelector(?:All)?\s*\(/u);
    expect(source).not.toMatch(/\.bind\s*\(/u);
    expect(source).not.toMatch(/data-action/u);
  }

  for (const controller of controllers) {
    expect(controller).not.toMatch(/onChange/u);
    expect(controller).not.toMatch(/addEventListener/u);
  }
});

test("stateful components retain reactive props and Solid list control flow", async () => {
  const [collection, sessionClient, sessionDetail] = await Promise.all(
    [
      "solid/collection.tsx",
      "solid/session-client.tsx",
      "solid/session-detail-client.tsx",
    ].map(readProjectFile),
  );

  expect(collection).toMatch(/<For\s+each=/u);
  expect(collection).not.toMatch(/items\.map\s*\(/u);
  for (const source of [sessionClient, sessionDetail]) {
    expect(source).not.toMatch(/const\s+state\s*=\s*props\.state/u);
  }
});

test("remount-era focus and scroll restoration markers are gone", async () => {
  const paths = await Array.fromAsync(
    new Bun.Glob("solid/*.{ts,tsx}").scan({ onlyFiles: true }),
  );
  const sources = await Promise.all(paths.map(readProjectFile));

  for (const source of sources) {
    for (const marker of REMOUNT_RESTORATION_MARKERS) {
      expect(source).not.toContain(marker);
    }
  }
});
