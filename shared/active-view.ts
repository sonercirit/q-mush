export interface ActiveView {
  readonly complete: boolean;
  readonly origin: "engine" | "runner";
  readonly partial: true;
  readonly records: readonly Record<string, unknown>[];
}

export interface ActiveViewReader {
  readonly readView: (
    entity: string,
    limit: number,
    sessionId?: string,
  ) => Omit<ActiveView, "origin">;
}

export function validActiveViewLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;
}
