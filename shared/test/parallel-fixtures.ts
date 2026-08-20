import { expect } from "vitest";

export interface ParallelToolUseFixture {
  readonly parameters: {
    readonly content: string;
    readonly index: number;
    readonly path: string;
  };
  readonly recipient_name: string;
}

export function expectCompleteParallelPayload(
  output: string,
  payload: string,
): void {
  expect(output).toContain(payload);
  expect(output).not.toContain("parallel output truncated");
}

export function createParallelToolUses(
  count: number,
  recipientName: (index: number) => string,
): readonly ParallelToolUseFixture[] {
  const calls: ParallelToolUseFixture[] = [];
  for (let index = 0; index < count; index += 1) {
    calls.push({
      parameters: {
        content: String(index),
        index,
        path: `result-${String(index).padStart(2, "0")}.txt`,
      },
      recipient_name: recipientName(index),
    });
  }
  return calls;
}
