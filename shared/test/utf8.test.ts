import { expect, test } from "vitest";
import { utf8ByteLength, utf8Prefix } from "../utf8.ts";

function withoutBuffer<Value>(action: () => Value): Value {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    value: undefined,
  });
  try {
    return action();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Buffer");
    } else {
      Object.defineProperty(globalThis, "Buffer", descriptor);
    }
  }
}

test("measures and truncates UTF-8 without the Node Buffer global", () => {
  const result = withoutBuffer(() => ({
    bomPrefix: utf8Prefix("\uFEFFA", 3),
    byteLength: utf8ByteLength("A😀B"),
    completePrefix: utf8Prefix("A😀B", 5),
    splitPrefix: utf8Prefix("A😀B", 4),
  }));

  expect(result).toEqual({
    bomPrefix: "\uFEFF",
    byteLength: 6,
    completePrefix: "A😀",
    splitPrefix: "A",
  });
});
