export function validOptionalImagePayload(
  payload: Readonly<Record<string, unknown>>,
  baseKeys: number,
): boolean {
  return (
    Object.keys(payload).length ===
      baseKeys + (payload["images"] === undefined ? 0 : 1) &&
    (payload["images"] === undefined || Array.isArray(payload["images"]))
  );
}
