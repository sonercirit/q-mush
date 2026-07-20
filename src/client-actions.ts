export function bindActionClicks(
  container: Element | null,
  handle: (control: HTMLElement, action: string | undefined) => void,
): void {
  container?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const control = event.target.closest<HTMLElement>("[data-action]");

    if (control !== null) {
      handle(control, control.dataset["action"]);
    }
  });
}
