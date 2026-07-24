export function mountClientApp<T>(
  root: HTMLElement,
  mount: (root: HTMLElement) => T,
): T {
  root.replaceChildren();
  return mount(root);
}
