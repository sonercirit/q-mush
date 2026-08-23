import { createActiveSessionTools } from "../active-session-tools.ts";
import { SessionLauncher } from "../session-launcher.ts";

type TestSessionLauncherDependencies = Omit<
  ConstructorParameters<typeof SessionLauncher>[0],
  "activeTools" | "braveSearch" | "realtime" | "shutdownInterrupted"
>;

export function createSessionLauncher(
  dependencies: TestSessionLauncherDependencies,
): SessionLauncher {
  return new SessionLauncher({
    ...dependencies,
    activeTools: createActiveSessionTools(),
    braveSearch: { execute: () => Promise.resolve("unused search") },
    realtime: undefined,
    shutdownInterrupted: {
      clear: () => false,
      mark: () => false,
    },
  });
}
