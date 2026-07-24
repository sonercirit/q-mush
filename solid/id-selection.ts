export function findById<Value extends { readonly id: string }>(
  values: readonly Value[],
  id: string,
): Value | undefined {
  return values.find((value) => value.id === id);
}
