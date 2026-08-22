import type {
  ActiveSessionTools,
  ActiveToolInvocationOptions,
} from "./active-session-tools.ts";

export type ActiveToolTracker = (
  callId: string,
  name: string,
  options?: ActiveToolInvocationOptions,
) => () => void;

export function activeToolTracker(
  activeTools: ActiveSessionTools,
  sessionId: string,
): ActiveToolTracker {
  return (callId, name, options) =>
    activeTools.begin(sessionId, callId, name, options);
}
