import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startDevelopmentServer,
  triggerDevelopmentRestart,
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

async function expectStableStartCount(
  pathname: string,
  expected: number,
): Promise<void> {
  await Bun.sleep(100);
  expect(await readStartCount(pathname)).toBe(expected);
}

test("keeps changed source running until the restart trigger changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-dev-test-"));
  const sourceDirectory = join(directory, "src");
  const childPath = join(directory, "child.ts");
  const startsPath = join(directory, "starts.txt");
  const triggerPath = join(directory, "restart.trigger");
  let server: DevelopmentServer | undefined;

  try {
    await mkdir(sourceDirectory);
    await Bun.write(triggerPath, "");
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
      restartTriggerPath: triggerPath,
    });

    await waitForStartCount(startsPath, 1);
    await Bun.write(join(sourceDirectory, "client.tsx"), "changed\n");
    await expectStableStartCount(startsPath, 1);

    await triggerDevelopmentRestart(triggerPath);
    await waitForStartCount(startsPath, 2);
    await expectStableStartCount(startsPath, 2);
  } finally {
    await server?.stop();
    await rm(directory, { force: true, recursive: true });
  }
});
