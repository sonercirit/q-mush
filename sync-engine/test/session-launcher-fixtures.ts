import { createActiveSessionTools } from "../active-session-tools.ts";
import {
  createSessionLauncher,
  type SessionLauncher,
  type SessionLauncherDependencies,
} from "../session-launcher.ts";

type TestSessionLauncherDependencies = Omit<
  SessionLauncherDependencies,
  "activeTools" | "braveSearch" | "realtime" | "shutdownInterrupted"
>;

export function createTestSessionLauncher(
  dependencies: TestSessionLauncherDependencies,
): SessionLauncher {
  return createSessionLauncher({
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
