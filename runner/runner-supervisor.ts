import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const RESTART_DELAY_MILLISECONDS = 5_000;

interface SupervisedRunnerProcess {
  kill(signal?: NodeJS.Signals): boolean;
  readonly result: Promise<number>;
}

interface RunnerSupervisorDependencies {
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly launch?: (
    executablePath: string,
    arguments_: readonly string[],
  ) => SupervisedRunnerProcess;
  readonly log?: (message: string) => void;
  readonly onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly removeSignalListener?: (
    signal: NodeJS.Signals,
    listener: () => void,
  ) => void;
}

function launchRunner(
  executablePath: string,
  arguments_: readonly string[],
): SupervisedRunnerProcess {
  const child = spawn(executablePath, arguments_, { stdio: "inherit" });
  return {
    kill: (signal) => child.kill(signal),
    result: new Promise<number>((resolve) => {
      child.once("error", () => {
        resolve(1);
      });
      child.once("exit", (code, signal) => {
        resolve(signal === null ? (code ?? 1) : 0);
      });
    }),
  };
}

export async function superviseRunner(
  executable: string,
  configuration: string,
  dependencies: RunnerSupervisorDependencies = {},
): Promise<never> {
  const delay = dependencies.delay ?? setTimeout;
  const launch = dependencies.launch ?? launchRunner;
  const log = dependencies.log ?? console.warn;
  const onSignal =
    dependencies.onSignal ??
    ((signal, listener) => {
      process.once(signal, listener);
    });
  const removeSignalListener =
    dependencies.removeSignalListener ??
    ((signal, listener) => {
      process.off(signal, listener);
    });
  for (;;) {
    const child = launch(executable, ["--config", configuration]);
    const stop = (): void => {
      child.kill("SIGTERM");
    };
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
    const result = await child.result;
    removeSignalListener("SIGINT", stop);
    removeSignalListener("SIGTERM", stop);
    log(
      `Q Mush runner exited with status ${String(result)}; restarting in 5 seconds.`,
    );
    await delay(RESTART_DELAY_MILLISECONDS);
  }
}
