export function normalizeSearchText(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLocaleLowerCase();
}
