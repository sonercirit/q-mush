import { expect, vi } from "vitest";

export function expectNoTimers(): void {
  expect(vi.getTimerCount()).toBe(0);
}
