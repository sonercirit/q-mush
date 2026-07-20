import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  startDevelopmentServer,
  type DevelopmentServer,
} from "../development-server.ts";

async function readStartCount(pathname: string): Promise<number> {
  const file = Bun.file(pathname);

  if (!(await file.exists())) {
    return 0;
  }

  return (await file.text()).split("started\n").length - 1;
}

async function waitForStartCount(
  pathname: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if ((await readStartCount(pathname)) >= expected) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(
    `The development server did not start ${String(expected)} times`,
  );
}

test("restarts the development server when a watched source file changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "q-mush-dev-test-"));
  const sourceDirectory = path.join(directory, "src");
  const childPath = path.join(directory, "child.ts");
  const startsPath = path.join(directory, "starts.txt");
  let server: DevelopmentServer | undefined;

  try {
    await mkdir(sourceDirectory);
    await Bun.write(
      childPath,
      `import { appendFileSync } from "node:fs";
const startsPath = process.argv[2];
if (startsPath === undefined) throw new Error("Missing starts path");
appendFileSync(startsPath, "started\\n");
await new Promise(() => {});
`,
    );
    server = startDevelopmentServer({
      command: [process.execPath, childPath, startsPath],
      cwd: directory,
      restartDelayMilliseconds: 20,
      watchPaths: [sourceDirectory],
    });

    await waitForStartCount(startsPath, 1);
    await Bun.write(path.join(sourceDirectory, "client.tsx"), "changed\n");
    await waitForStartCount(startsPath, 2);
    await Bun.sleep(100);

    expect(await readStartCount(startsPath)).toBe(2);
  } finally {
    await server?.stop();
    await rm(directory, { force: true, recursive: true });
  }
});
