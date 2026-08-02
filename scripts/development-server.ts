import { watch } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_SHUTDOWN_FORCE_MILLISECONDS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MILLISECONDS = 10_000;

interface DevelopmentServerOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly restartDelayMilliseconds?: number;
  readonly restartTriggerPath: string;
  readonly shutdownForceMilliseconds?: number;
  readonly shutdownGraceMilliseconds?: number;
}

export interface DevelopmentServer {
  forceStop(): void;
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

function positiveDelay(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? fallback
    : value;
}

export function startDevelopmentServer(
  options: DevelopmentServerOptions,
): DevelopmentServer {
  const spawn = () =>
    Bun.spawn([...options.command], {
      cwd: options.cwd,
      detached: true,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
  const graceMilliseconds = positiveDelay(
    options.shutdownGraceMilliseconds,
    DEFAULT_SHUTDOWN_GRACE_MILLISECONDS,
  );
  const forceMilliseconds = positiveDelay(
    options.shutdownForceMilliseconds,
    DEFAULT_SHUTDOWN_FORCE_MILLISECONDS,
  );
  let child = spawn();
  let operation = Promise.resolve();
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const signalChild = (signal: NodeJS.Signals): void => {
    if (child.exitCode !== null) {
      return;
    }
    const pid = process.platform === "win32" ? child.pid : -child.pid;
    try {
      process.kill(pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const childSettledWithin = (milliseconds: number): Promise<boolean> => {
    const settled = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      settled.resolve(false);
    }, milliseconds);
    void child.exited.then(() => {
      settled.resolve(true);
    });
    return settled.promise.finally(() => {
      clearTimeout(timer);
    });
  };

  const drainChild = async (): Promise<void> => {
    signalChild("SIGTERM");
    await child.exited;
  };

  const shutDownChild = async (): Promise<void> => {
    signalChild("SIGTERM");
    if (await childSettledWithin(graceMilliseconds)) {
      return;
    }
    signalChild("SIGKILL");
    if (!(await childSettledWithin(forceMilliseconds))) {
      child.unref();
      throw new Error("The development server did not terminate after SIGKILL");
    }
  };

  const scheduleRestart = (): void => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
    }

    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      operation = operation.then(async () => {
        await drainChild();

        if (!stopping) {
          child = spawn();
        }
      });
    }, options.restartDelayMilliseconds ?? 50);
  };

  const restartTrigger = watch(options.restartTriggerPath, scheduleRestart);

  const closeSupervisorResources = (): void => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    restartTrigger.close();
  };

  const forceStop = (): void => {
    stopping = true;
    closeSupervisorResources();
    signalChild("SIGKILL");
    child.unref();
  };

  return {
    forceStop,
    stop: () => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopping = true;

      closeSupervisorResources();
      stopPromise = shutDownChild();
      return stopPromise;
    },
  };
}
