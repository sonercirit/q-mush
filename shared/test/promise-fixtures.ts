export interface TestDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

export function testDeferred<Value>(): TestDeferred<Value> {
  return Promise.withResolvers<Value>();
}
