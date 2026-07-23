import type { CustomSelectOption } from "../custom-select.tsx";

export function customSelectOptions(
  count: number,
): readonly CustomSelectOption[] {
  return Array.from({ length: count }, (_, index) => {
    const position = String(index + 1);
    return {
      description: `Description ${position}`,
      detail: `${position} detail`,
      label: `Option ${position}`,
      value: `option-${position}`,
    };
  });
}
