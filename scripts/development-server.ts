import { watch } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FINAL_SHUTDOWN_PREPARED_MESSAGE } from "../shared/development-shutdown.ts";

const DEFAULT_SHUTDOWN_FORCE_MILLISECONDS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MILLISECONDS = 10_000;
const DEFAULT_SHUTDOWN_PREPARATION_MILLISECONDS = 30_000;

interface DevelopmentServerOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly restartDelayMilliseconds?: number;
  readonly restartTriggerPath: string;
  readonly shutdownForceMilliseconds?: number;
  readonly shutdownGraceMilliseconds?: number;
  readonly shutdownPreparationMilliseconds?: number;
}

export interface DevelopmentServer {
  forceStop(): Promise<void>;
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
  let preparation = Promise.withResolvers<undefined>();
  let forced = Promise.withResolvers<undefined>();
  let forceRequested = false;
  const spawn = () =>
    Bun.spawn([...options.command], {
      cwd: options.cwd,
      detached: true,
      ipc: (message) => {
        if (message === FINAL_SHUTDOWN_PREPARED_MESSAGE) {
          preparation.resolve();
        }
      },
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
  const preparationMilliseconds = positiveDelay(
    options.shutdownPreparationMilliseconds,
    DEFAULT_SHUTDOWN_PREPARATION_MILLISECONDS,
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

  const childSettledWithin = (
    milliseconds: number,
    interruption?: Promise<unknown>,
  ): Promise<boolean> => {
    const settled = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      settled.resolve(false);
    }, milliseconds);
    void child.exited.then(() => {
      settled.resolve(true);
    });
    void interruption?.then(() => {
      settled.resolve(false);
    });
    return settled.promise.finally(() => {
      clearTimeout(timer);
    });
  };

  const drainChild = async (): Promise<void> => {
    signalChild("SIGTERM");
    await child.exited;
  };

  const preparationFinishedWithin = async (): Promise<boolean> => {
    const timeout = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      timeout.resolve(false);
    }, preparationMilliseconds);
    const prepared = await Promise.race([
      preparation.promise.then(() => true),
      child.exited.then(() => false),
      timeout.promise,
    ]);
    clearTimeout(timer);
    return prepared;
  };

  const shutDownChild = async (): Promise<void> => {
    signalChild("SIGTERM");
    const prepared = await preparationFinishedWithin();
    if (
      child.exitCode !== null ||
      (prepared &&
        !forceRequested &&
        (await childSettledWithin(graceMilliseconds, forced.promise)))
    ) {
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
          preparation = Promise.withResolvers<undefined>();
          forced = Promise.withResolvers<undefined>();
          forceRequested = false;
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

  const forceStop = (): Promise<void> => {
    stopping = true;
    closeSupervisorResources();
    forceRequested = true;
    forced.resolve();
    stopPromise ??= shutDownChild();
    return stopPromise;
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
