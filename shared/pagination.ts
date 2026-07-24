export function validPageWindow(offset: number, limit: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(limit) &&
    limit >= 1
  );
}
