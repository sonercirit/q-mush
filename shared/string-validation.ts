export function withoutControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 32 && (codePoint < 127 || codePoint > 159)) {
      output += character;
    }
  }
  return output;
}

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
