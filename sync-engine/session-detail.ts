import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";

export function requiredSessionDetail(
  read: SessionDetailLookup,
  parameters: Parameters<SessionDetailLookup>,
  error: () => Error,
): AgentSessionDetail {
  const detail = read(...parameters);
  if (detail === undefined) {
    throw error();
  }
  return detail;
}
