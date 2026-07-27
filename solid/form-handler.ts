export function submitFormName(
  event: SubmitEvent & { readonly currentTarget: HTMLFormElement },
  submit: (name: string) => void,
): void {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name");
  if (typeof name === "string") {
    submit(name);
  }
}
