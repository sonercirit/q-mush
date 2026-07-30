import type { AgentSessionToolName } from "../shared/agent-tools.ts";

export function currentExecutionTools(options: {
  readonly current: readonly AgentSessionToolName[] | undefined;
  readonly isCurrent: () => boolean;
  readonly persisted: readonly AgentSessionToolName[];
}): readonly AgentSessionToolName[] | undefined {
  // Nonempty `persisted` is the tool snapshot for this generation. A live
  // empty value is therefore transient unless the generation was fenced.
  if (!options.isCurrent()) {
    return undefined;
  }
  if (
    options.current !== undefined &&
    (options.current.length > 0 || options.persisted.length === 0)
  ) {
    return options.current;
  }
  return options.persisted;
}
