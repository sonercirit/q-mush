import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, type Mock } from "vitest";
import {
  startDevelopmentSourceWatcher,
  type DevelopmentSourceWatcher,
} from "../development-source-watcher.ts";

interface WatcherFixture {
  readonly changed: Mock;
  readonly directory: string;
  readonly watcher: DevelopmentSourceWatcher;
}

async function watcherFixture(): Promise<WatcherFixture> {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-source-watch-"));
  await mkdir(join(directory, "sync-engine"));
  const changed = vi.fn();
  const watcher = await startDevelopmentSourceWatcher({
    debounceMilliseconds: 40,
    onChange: changed,
    projectRoot: directory,
  });
  return { changed, directory, watcher };
}

async function closeWatcher(fixture: WatcherFixture): Promise<void> {
  fixture.watcher.stop();
  await rm(fixture.directory, { force: true, recursive: true });
}

async function waitForChange(fixture: WatcherFixture): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fixture.changed.mock.calls.length > 0) break;
    await Bun.sleep(10);
  }
  expect(fixture.changed).toHaveBeenCalled();
  await Bun.sleep(150);
}

async function writeAndExpectChanges(
  fixture: WatcherFixture,
  paths: readonly string[],
  expected: number,
): Promise<void> {
  for (const pathname of paths) {
    await Bun.write(join(fixture.directory, pathname), `${pathname}\n`);
  }
  if (expected > 0) {
    await waitForChange(fixture);
  } else {
    await Bun.sleep(150);
  }
  expect(fixture.changed).toHaveBeenCalledTimes(expected);
}

test("coalesces a production source edit burst into one change", async () => {
  const fixture = await watcherFixture();
  try {
    await writeAndExpectChanges(
      fixture,
      [
        "sync-engine/server.ts",
        "sync-engine/sessions.ts",
        "sync-engine/server.ts",
      ],
      1,
    );
  } finally {
    await closeWatcher(fixture);
  }
});

test.each([".env", ".env.local"])(
  "detects %s creation and replacement",
  async (name) => {
    const fixture = await watcherFixture();
    try {
      await writeAndExpectChanges(fixture, [name], 1);
    } finally {
      await closeWatcher(fixture);
    }
  },
);

test("ignores generated, test, VCS, data, and temporary paths", async () => {
  const fixture = await watcherFixture();
  try {
    for (const directory of ["data", ".git", "dist", "sync-engine/test"]) {
      await mkdir(join(fixture.directory, directory), { recursive: true });
    }
    await writeAndExpectChanges(
      fixture,
      [
        "data/q-mush.sqlite",
        ".git/index",
        "dist/client.js",
        "sync-engine/test/server.test.ts",
        "sync-engine/server.ts.swp",
      ],
      0,
    );
  } finally {
    await closeWatcher(fixture);
  }
});
