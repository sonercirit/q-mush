export function listsMatchByIdentity<Item>(
  left: readonly Item[] | undefined,
  right: readonly Item[],
): boolean {
  if (left?.length !== right.length) {
    return false;
  }
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function retainById<Item extends { readonly id: string }>(
  current: readonly Item[] | undefined,
  incoming: readonly Item[],
  matches: (left: Item, right: Item) => boolean,
): readonly Item[] {
  if (current === undefined) {
    return incoming;
  }

  const currentById = new Map(current.map((item) => [item.id, item]));
  const retained: Item[] = [];
  for (const item of incoming) {
    const existing = currentById.get(item.id);
    retained.push(
      existing === undefined || !matches(existing, item) ? item : existing,
    );
  }
  return retained;
}
