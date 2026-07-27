export interface DiscoveryState<Value> {
  readonly catalog: Value | undefined;
  readonly loading: boolean;
}

export function shouldDiscover<Value>(options: {
  readonly currentKey: string | undefined;
  readonly expectedKey: string;
  readonly force: boolean;
  readonly state: DiscoveryState<Value>;
}): boolean {
  return (
    options.force ||
    options.currentKey !== options.expectedKey ||
    (!options.state.loading && options.state.catalog === undefined)
  );
}
