import { countRestartProgressTools } from "../shared/restart-progress-tools.ts";

export interface ActiveToolProgress {
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

export class ActiveSessionTools {
  readonly #active = new Map<string, Map<string, ActiveToolInvocation>>();
  #nextInvocation = 0;

  begin(
    sessionId: string,
    callId: string,
    tool: string,
    options: ActiveToolInvocationOptions = {},
  ): () => void {
    const session =
      this.#active.get(sessionId) ?? new Map<string, ActiveToolInvocation>();
    this.#nextInvocation += 1;
    const invocationId = `${callId}:${String(this.#nextInvocation)}`;
    session.set(invocationId, {
      name: tool,
      runnerCommand: options.runnerCommand ?? false,
    });
    this.#active.set(sessionId, session);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const current = this.#active.get(sessionId);
      current?.delete(invocationId);
      if (current?.size === 0) {
        this.#active.delete(sessionId);
      }
    };
  }

  progress(
    sessionId: string,
    includeRunnerCommands = true,
  ): readonly ActiveToolProgress[] {
    const names = [...(this.#active.get(sessionId)?.values() ?? [])].flatMap(
      ({ name, runnerCommand }) =>
        includeRunnerCommands || !runnerCommand ? [name] : [],
    );
    return countRestartProgressTools(names);
  }
}
