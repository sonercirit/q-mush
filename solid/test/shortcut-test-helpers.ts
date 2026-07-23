export function shortcutKeyEvent(
  target: EventTarget,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

export function shortcutInput(
  type: "input" | "textarea",
): HTMLInputElement | HTMLTextAreaElement {
  const element = document.createElement(type);
  document.body.append(element);
  return element;
}
