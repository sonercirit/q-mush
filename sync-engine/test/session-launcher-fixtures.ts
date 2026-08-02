import { SessionLauncher } from "../session-launcher.ts";

type TestSessionLauncherDependencies = Omit<
  ConstructorParameters<typeof SessionLauncher>[0],
  "braveSearch" | "realtime" | "shutdownInterrupted"
>;

export function createSessionLauncher(
  dependencies: TestSessionLauncherDependencies,
): SessionLauncher {
  return new SessionLauncher({
    ...dependencies,
    braveSearch: { execute: () => Promise.resolve("unused search") },
    realtime: undefined,
    shutdownInterrupted: {
      clear: () => false,
      mark: () => false,
    },
  });
}
