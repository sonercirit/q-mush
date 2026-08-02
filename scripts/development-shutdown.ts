import type { DevelopmentServer } from "./development-server.ts";

interface DevelopmentShutdownOptions {
  readonly developmentServer: DevelopmentServer;
  readonly exit?: (code: number) => void;
  readonly stopSourceWatcher: () => void;
}

export function createDevelopmentShutdown(
  options: DevelopmentShutdownOptions,
): (exitCode: number) => void {
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });
  let exiting = false;
  let forced = false;
  const forceExit = (exitCode: number): void => {
    if (!forced) {
      forced = true;
      options.developmentServer.forceStop().then(
        () => {
          exit(exitCode);
        },
        () => {
          exit(exitCode);
        },
      );
    }
  };

  return (exitCode) => {
    if (exiting) {
      forceExit(exitCode);
      return;
    }

    exiting = true;
    options.stopSourceWatcher();
    void options.developmentServer.stop().then(
      () => {
        if (!forced) {
          exit(exitCode);
        }
      },
      () => {
        forceExit(exitCode);
      },
    );
  };
}
