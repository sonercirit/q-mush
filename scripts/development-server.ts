import { watch } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface DevelopmentServerOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly restartDelayMilliseconds?: number;
  readonly restartTriggerPath: string;
}

export interface DevelopmentServer {
  stop(): Promise<void>;
}

export function developmentRestartTriggerPath(projectRoot: string): string {
  return join(projectRoot, "data", "development-server.restart");
}

export async function prepareDevelopmentRestartTrigger(
  pathname: string,
): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  await appendFile(pathname, "");
}

export async function triggerDevelopmentRestart(
  pathname: string,
): Promise<void> {
  await prepareDevelopmentRestartTrigger(pathname);
  await appendFile(pathname, `${String(Date.now())}\n`);
}

export function startDevelopmentServer(
  options: DevelopmentServerOptions,
): DevelopmentServer {
  const spawn = () =>
    Bun.spawn([...options.command], {
      cwd: options.cwd,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
  let child = spawn();
  let operation = Promise.resolve();
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const stopChild = async (): Promise<void> => {
    child.kill();
    await child.exited;
  };

  const scheduleRestart = (): void => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
    }

    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      operation = operation.then(async () => {
        await stopChild();

        if (!stopping) {
          child = spawn();
        }
      });
    }, options.restartDelayMilliseconds ?? 50);
  };

  const restartTrigger = watch(options.restartTriggerPath, scheduleRestart);

  return {
    stop: () => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopping = true;

      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }

      restartTrigger.close();

      stopPromise = operation.then(stopChild);
      return stopPromise;
    },
  };
}
