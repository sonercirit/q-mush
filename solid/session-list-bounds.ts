export interface BoundedSessionRow {
  readonly depth: number;
  readonly session: { readonly id: string };
}

export function boundedSessionRows<Row extends BoundedSessionRow>(
  rows: readonly Row[],
  limit: number,
  selectedId: string | undefined,
): readonly Row[] {
  if (rows.length <= limit) return rows;
  const selectedIndex = rows.findIndex(
    ({ session }) => session.id === selectedId,
  );
  if (selectedIndex < limit) return rows.slice(0, limit);

  const selectedPath: Row[] = [];
  let expectedDepth = rows[selectedIndex]?.depth ?? -1;
  for (
    let index = selectedIndex;
    index >= 0 && expectedDepth >= 0;
    index -= 1
  ) {
    const row = rows[index];
    if (row?.depth === expectedDepth) {
      selectedPath.push(row);
      expectedDepth -= 1;
    }
  }
  const requiredRows = selectedPath.reverse().slice(-limit);
  const requiredIds = new Set(requiredRows.map(({ session }) => session.id));
  const leadingRows = rows
    .slice(0, limit)
    .filter(({ session }) => !requiredIds.has(session.id))
    .slice(0, limit - requiredRows.length);
  const includedIds = new Set(
    [...leadingRows, ...requiredRows].map(({ session }) => session.id),
  );
  return rows.filter(({ session }) => includedIds.has(session.id));
}
