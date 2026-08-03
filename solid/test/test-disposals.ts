import { afterEach } from "vitest";

export function testDisposals(): (() => void)[] {
  const stack: (() => void)[] = [];
  afterEach(function releaseMountedViews() {
    for (;;) {
      const release = stack.shift();
      if (release === undefined) break;
      release();
    }
  });
  return stack;
}
