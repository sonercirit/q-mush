const dataDescriptor = (
  value: object,
  key: PropertyKey,
): PropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("Operation values must contain only data properties");
  return descriptor;
};

/** Validates the original shape and returns plain data read once from descriptors. */
export function snapshotOperationValue<T>(value: T): T;
export function snapshotOperationValue(value: unknown): unknown;
export function snapshotOperationValue(value: unknown): unknown {
  const seen = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (
      item === undefined ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "bigint" ||
      item === null
    )
      return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new Error("Operation numbers must be finite");
      if (Object.is(item, -0))
        throw new Error("Operation numbers must not be negative zero");
      return item;
    }
    if (typeof item !== "object")
      throw new Error("Unsupported operation value");
    if (seen.has(item))
      throw new Error("Operation values must be reference-free trees");
    seen.add(item);
    let snapshot: unknown;
    if (item instanceof Date) {
      if (!Number.isFinite(item.getTime()))
        throw new Error("Operation dates must be valid");
      if (
        Object.getPrototypeOf(item) !== Date.prototype ||
        Reflect.ownKeys(item).length > 0
      )
        throw new Error("Operation dates must not have own properties");
      snapshot = new Date(item.getTime());
    } else if (Array.isArray(item)) {
      const keys = Reflect.ownKeys(item);
      const lengthValue: unknown = dataDescriptor(item, "length").value;
      if (typeof lengthValue !== "number")
        throw new Error("Operation arrays must have a numeric length");
      const length = lengthValue;
      if (
        keys.length !== length + 1 ||
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9]\d*)$/.test(key) ||
              Number(key) >= length),
        )
      )
        throw new Error(
          "Operation arrays must not be sparse or contain extra properties",
        );
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = dataDescriptor(item, String(index));
        if (!descriptor.enumerable)
          throw new Error("Operation arrays must not be sparse");
        result.push(visit(descriptor.value));
      }
      snapshot = result;
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      const keys = Reflect.ownKeys(item);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.some((key) => typeof key !== "string")
      )
        throw new Error(
          "Operation objects must be plain, string-keyed, and enumerable",
        );
      const entries: [string, unknown][] = [];
      const stringKeys = keys.filter(
        (key): key is string => typeof key === "string",
      );
      for (const key of stringKeys) {
        const descriptor = dataDescriptor(item, key);
        if (!descriptor.enumerable)
          throw new Error("Operation objects must contain enumerable data");
        entries.push([key, visit(descriptor.value)]);
      }
      snapshot = Object.fromEntries(entries);
    }
    return snapshot;
  };
  return visit(value);
}
