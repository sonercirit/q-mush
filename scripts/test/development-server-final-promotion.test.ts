import { expect, test } from "vitest";
import {
  startDevelopmentServer,
  triggerDevelopmentRestart,
} from "../development-server.ts";
import {
  waitForTemporaryFileContent,
  withTemporaryDirectory,
} from "./temporary-directory.ts";

function promotedChildSource(): string {
  return `import { appendFileSync } from "node:fs";
const eventsPath = process.argv[2];
if (eventsPath === undefined) throw new Error("Missing events path");
const record = (event) => appendFileSync(eventsPath, event + "\\n");
record("started");
process.on("message", (message) => {
  if (typeof message === "object" && message?.type === "q-mush:development-restart-request") {
    record("development-request");
  }
  if (message === "q-mush:final-shutdown-request") {
    record("final-request");
    process.send?.("q-mush:final-shutdown-prepared");
    setTimeout(() => { record("final-drained"); process.exit(); }, 180);
  }
});
process.on("SIGTERM", () => record("sigterm"));
setInterval(() => undefined, 1_000);
`;
}

function promotedServerOptions(
  directory: string,
  triggerPath: string,
  childPath: string,
  eventsPath: string,
) {
  return {
    shutdownPreparationMilliseconds: 100,
    shutdownGraceMilliseconds: 500,
    restartTriggerPath: triggerPath,
    restartDelayMilliseconds: 10,
    cwd: directory,
    command: [process.execPath, childPath, eventsPath],
  };
}

async function readFileLines(pathname: string): Promise<readonly string[]> {
  return (await Bun.file(pathname).text()).trim().split("\n");
}

test("final stop cancels an active development deadline after durable preparation", async () => {
  await withTemporaryDirectory(
    "q-mush-dev-final-promotion-test-",
    async (directory) => {
      const triggerPath = `${directory}/restart.trigger`;
      const childPath = `${directory}/promoted-child.ts`;
      const eventsPath = `${directory}/promoted-events.txt`;
      await Bun.write(triggerPath, "");
      await Bun.write(childPath, promotedChildSource());
      const server = startDevelopmentServer(
        promotedServerOptions(directory, triggerPath, childPath, eventsPath),
      );

      await waitForTemporaryFileContent(eventsPath, "started");
      await triggerDevelopmentRestart(triggerPath);
      await waitForTemporaryFileContent(eventsPath, "development-request");
      await server.stop();

      expect(await readFileLines(eventsPath)).toEqual([
        "started",
        "development-request",
        "final-request",
        "final-drained",
      ]);
    },
  );
});
