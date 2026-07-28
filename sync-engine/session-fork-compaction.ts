import type { SessionForkSelection } from "../shared/session-fork.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export function compactChangedSessionFork(options: {
  readonly compact: () => Promise<AgentSessionDetail>;
  readonly detail: AgentSessionDetail;
  readonly selection: SessionForkSelection | undefined;
  readonly source: AgentSessionDetail;
}): Promise<AgentSessionDetail> {
  const { selection } = options;
  return selection !== undefined &&
    (selection.provider !== options.source.provider ||
      selection.model !== options.source.model)
    ? options.compact()
    : Promise.resolve(options.detail);
}
