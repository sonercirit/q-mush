interface ScrollTarget {
  getAttribute(name: string): string | null;
  readonly scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
}

type ReadScrollTargets = () => ReadonlyMap<string, ScrollTarget>;

export function updatePreservingScrollPositions(
  readTargets: ReadScrollTargets,
  update: () => void,
): void {
  const positions = new Map(
    [...readTargets()].map(([key, target]) => [
      key,
      {
        left: target.scrollLeft,
        revision: target.getAttribute("data-scroll-revision"),
        top: target.scrollTop,
      },
    ]),
  );

  update();

  for (const [key, target] of readTargets()) {
    const position = positions.get(key);

    const scrollToEnd = target.getAttribute("data-scroll-on-change") === "end";

    if (position === undefined) {
      if (scrollToEnd) {
        target.scrollTop = target.scrollHeight;
      }

      continue;
    }

    target.scrollLeft = position.left;
    target.scrollTop =
      scrollToEnd &&
      target.getAttribute("data-scroll-revision") !== position.revision
        ? target.scrollHeight
        : position.top;
  }
}
