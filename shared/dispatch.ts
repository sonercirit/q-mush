export function isDispatchKey<Key extends string>(
  handlers: Readonly<Record<Key, unknown>>,
  value: unknown,
): value is Key {
  return typeof value === "string" && Object.hasOwn(handlers, value);
}
