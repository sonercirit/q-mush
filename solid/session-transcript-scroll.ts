const SCROLL_END_TOLERANCE = 64;

interface TranscriptScrollState {
  readonly programmaticScrollTop: number | undefined;
  readonly scrollLockEnabled: boolean;
}

export function isAtTranscriptScrollEnd(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    SCROLL_END_TOLERANCE
  );
}

export function transcriptScrollLock(
  element: HTMLElement,
  state: TranscriptScrollState,
  isAtScrollEnd: (element: HTMLElement) => boolean,
): boolean {
  const programmatic = element.scrollTop === state.programmaticScrollTop;
  // A scroll from our last write can arrive after streamed layout grows.
  // Preserve the lock for that event; user scrolling still uses proximity.
  return programmatic ? state.scrollLockEnabled : isAtScrollEnd(element);
}
