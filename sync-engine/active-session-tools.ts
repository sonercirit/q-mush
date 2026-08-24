import { countRestartProgressTools } from "../shared/restart-progress-tools.ts";

interface ActiveToolProgress {
  readonly count: number;
  readonly name: string;
}

export interface ActiveToolInvocationOptions {
  readonly runnerCommand?: boolean;
}

interface ActiveToolInvocation {
  readonly name: string;
  readonly runnerCommand: boolean;
}

export interface ActiveSessionTools {
  begin(
    sessionId: string,
    callId: string,
    tool: string,
    options?: ActiveToolInvocationOptions,
  ): () => void;
  progress(
    sessionId: string,
    includeRunnerCommands?: boolean,
  ): readonly ActiveToolProgress[];
}

export function createActiveSessionTools(): ActiveSessionTools {
  const active = new Map<string, Map<string, ActiveToolInvocation>>();
  let nextInvocation = 0;

  return {
    begin(sessionId, callId, tool, options = {}) {
      const session =
        active.get(sessionId) ?? new Map<string, ActiveToolInvocation>();
      nextInvocation += 1;
      const invocationId = `${callId}:${String(nextInvocation)}`;
      session.set(invocationId, {
        name: tool,
        runnerCommand: options.runnerCommand ?? false,
      });
      active.set(sessionId, session);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const current = active.get(sessionId);
        current?.delete(invocationId);
        if (current?.size === 0) {
          active.delete(sessionId);
        }
      };
    },
    progress(sessionId, includeRunnerCommands = true) {
      const names = [...(active.get(sessionId)?.values() ?? [])].flatMap(
        ({ name, runnerCommand }) =>
          includeRunnerCommands || !runnerCommand ? [name] : [],
      );
      return countRestartProgressTools(names);
    },
  };
}
