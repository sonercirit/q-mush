export class DiscoveryCache<Value> {
  readonly #values = new Map<string, Value>();
  #request = 0;

  #apply(
    key: string,
    value: Value,
    apply: (key: string, value: Value) => void,
  ): void {
    apply(key, value);
  }

  begin(
    key: string,
    force: boolean,
    apply: (key: string, value: Value) => void,
    start: (request: number) => void,
  ): boolean {
    const cached = this.get(key, force);
    if (cached !== undefined) {
      this.#apply(key, cached, apply);
      return false;
    }
    start(this.nextRequest());
    return true;
  }

  clear(): void {
    this.#values.clear();
    this.#request += 1;
  }

  delete(): void {
    this.#request += 1;
  }

  get(key: string, force: boolean): Value | undefined {
    return force ? undefined : this.#values.get(key);
  }

  nextRequest(): number {
    this.#request += 1;
    return this.#request;
  }

  isCurrent(request: number): boolean {
    return request === this.#request;
  }

  catch(request: number, current: () => boolean): boolean {
    return this.isCurrent(request) && current();
  }

  handleFailure(
    request: number,
    current: () => boolean,
    fail: () => void,
  ): void {
    if (this.catch(request, current)) {
      fail();
    }
  }

  resolve(
    request: number,
    key: string,
    value: Value,
    current: () => boolean,
    apply: (key: string, value: Value) => void,
  ): boolean {
    if (!this.catch(request, current)) {
      return false;
    }
    this.set(key, value);
    this.#apply(key, value, apply);
    return true;
  }

  set(key: string, value: Value): void {
    this.#values.set(key, value);
  }
}
