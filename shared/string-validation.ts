export function isValidBoundedString(
  value: unknown,
  maximumLength: number,
  options: { readonly allowNullCharacter?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    (options.allowNullCharacter === true || !value.includes("\0"))
  );
}
