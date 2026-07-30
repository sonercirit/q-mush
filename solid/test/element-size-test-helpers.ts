function defineElementMeasurement(
  element: Element,
  clientProperty: "clientHeight" | "clientWidth",
  clientSize: number,
  scrollProperty: "scrollHeight" | "scrollWidth",
  scrollSize: number | (() => number),
): void {
  Object.defineProperties(element, {
    [clientProperty]: { configurable: true, value: clientSize },
    [scrollProperty]:
      typeof scrollSize === "function"
        ? { configurable: true, get: scrollSize }
        : { configurable: true, value: scrollSize },
  });
}

export function defineElementWidth(
  element: Element,
  clientWidth: number,
  scrollWidth: number | (() => number),
): void {
  defineElementMeasurement(
    element,
    "clientWidth",
    clientWidth,
    "scrollWidth",
    scrollWidth,
  );
}

export function defineElementSize(
  element: Element,
  clientHeight: number,
  scrollHeight: number | (() => number),
): void {
  defineElementMeasurement(
    element,
    "clientHeight",
    clientHeight,
    "scrollHeight",
    scrollHeight,
  );
}
