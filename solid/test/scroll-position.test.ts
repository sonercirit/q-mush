import { expect, test } from "vitest";
import { updatePreservingScrollPositions } from "../../solid/scroll-position.ts";

function scrollTarget(options?: {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly scrollHeight?: number;
  readonly scrollLeft?: number;
  readonly scrollTop?: number;
}) {
  const attributes = options?.attributes ?? {};

  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    scrollHeight: options?.scrollHeight ?? 1_000,
    scrollLeft: options?.scrollLeft ?? 0,
    scrollTop: options?.scrollTop ?? 0,
  };
}

test("restores matching scroll regions after an update replaces them", () => {
  const previousDocument = scrollTarget({ scrollLeft: 7, scrollTop: 480 });
  const previousTranscript = scrollTarget({ scrollTop: 192 });
  const nextDocument = scrollTarget();
  const nextTranscript = scrollTarget();
  const unrelatedTranscript = scrollTarget();
  let updated = false;

  updatePreservingScrollPositions(
    () =>
      new Map(
        updated
          ? [
              ["document", nextDocument],
              ["session:one", nextTranscript],
              ["session:two", unrelatedTranscript],
            ]
          : [
              ["document", previousDocument],
              ["session:one", previousTranscript],
            ],
      ),
    () => {
      updated = true;
    },
  );

  expect(nextDocument.scrollLeft).toBe(7);
  expect(nextDocument.scrollTop).toBe(480);
  expect(nextTranscript.scrollTop).toBe(192);
  expect(unrelatedTranscript.scrollTop).toBe(0);
});

test("scrolls a region to the end when its revision changes", () => {
  const previousTranscript = scrollTarget({
    attributes: {
      "data-scroll-on-change": "end",
      "data-scroll-revision": "message-1",
    },
    scrollHeight: 500,
    scrollTop: 192,
  });
  const nextTranscript = scrollTarget({
    attributes: {
      "data-scroll-on-change": "end",
      "data-scroll-revision": "message-2",
    },
    scrollHeight: 750,
  });
  let updated = false;

  updatePreservingScrollPositions(
    () =>
      new Map([["session:one", updated ? nextTranscript : previousTranscript]]),
    () => {
      updated = true;
    },
  );

  expect(nextTranscript.scrollTop).toBe(750);
});
