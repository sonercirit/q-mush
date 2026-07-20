interface ControlEnterEvent {
  readonly ctrlKey: boolean;
  readonly key: string;
  preventDefault(): void;
}

interface SubmittableForm {
  requestSubmit(): void;
}

export function submitFormOnControlEnter(
  event: ControlEnterEvent,
  form: SubmittableForm,
): void {
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    form.requestSubmit();
  }
}

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
