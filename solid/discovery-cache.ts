export interface DiscoveryCache<Value> {
  begin(
    key: string,
    force: boolean,
    apply: (key: string, value: Value) => void,
    start: (request: number) => void,
  ): boolean;
  clear(): void;
  delete(): void;
  get(key: string, force: boolean): Value | undefined;
  nextRequest(): number;
  isCurrent(request: number): boolean;
  catch(request: number, current: () => boolean): boolean;
  handleFailure(
    request: number,
    current: () => boolean,
    fail: () => void,
  ): void;
  resolve(
    request: number,
    key: string,
    value: Value,
    current: () => boolean,
    apply: (key: string, value: Value) => void,
  ): boolean;
  set(key: string, value: Value): void;
}

export function createDiscoveryCache<Value>(): DiscoveryCache<Value> {
  const values = new Map<string, Value>();
  let request = 0;
  const nextRequest = (): number => {
    request += 1;
    return request;
  };
  const isCurrent = (candidate: number): boolean => candidate === request;
  const caught = (candidate: number, current: () => boolean): boolean =>
    isCurrent(candidate) && current();
  const set = (key: string, value: Value): void => {
    values.set(key, value);
  };
  return {
    begin(key, force, apply, start) {
      const cached = force ? undefined : values.get(key);
      if (cached !== undefined) {
        apply(key, cached);
        return false;
      }
      start(nextRequest());
      return true;
    },
    clear() {
      values.clear();
      request += 1;
    },
    delete() {
      request += 1;
    },
    get: (key, force) => (force ? undefined : values.get(key)),
    nextRequest,
    isCurrent,
    catch: caught,
    handleFailure(candidate, current, fail) {
      if (caught(candidate, current)) fail();
    },
    resolve(candidate, key, value, current, apply) {
      if (!caught(candidate, current)) return false;
      set(key, value);
      apply(key, value);
      return true;
    },
    set,
  };
}
