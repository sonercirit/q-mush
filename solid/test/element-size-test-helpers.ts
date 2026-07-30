export function defineElementSize(
  element: Element,
  clientHeight: number,
  scrollHeight: number | (() => number),
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight:
      typeof scrollHeight === "function"
        ? { configurable: true, get: scrollHeight }
        : { configurable: true, value: scrollHeight },
  });
}
