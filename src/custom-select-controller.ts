export function customSelectValues(select: Element): readonly string[] {
  const values: string[] = [];

  for (const option of select.querySelectorAll<HTMLElement>(
    "[data-option-value]",
  )) {
    const value = option.dataset["optionValue"];

    if (value !== undefined) {
      values.push(value);
    }
  }

  return values;
}
