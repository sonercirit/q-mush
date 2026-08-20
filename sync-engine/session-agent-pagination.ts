function paginationMetadata(
  page: number,
  pageSize: number,
  totalItems: number,
): {
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
} {
  const totalPages = Math.ceil(totalItems / pageSize);
  return {
    hasNext: page < totalPages,
    hasPrevious: page > 1,
    page,
    pageSize,
    totalItems,
    totalPages,
  };
}

/** Pagination remains positional; the shared model-facing result bound applies later. */
export function boundedPaginatedOutput(input: {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly items: readonly unknown[];
  readonly page: number;
  readonly pageSize: number;
  readonly sourceFields: boolean;
  readonly totalItems: number;
}): string {
  const {
    fields = {},
    filters,
    items,
    page,
    pageSize,
    sourceFields,
    totalItems,
  } = input;
  return JSON.stringify(
    {
      ...fields,
      filters,
      ...paginationMetadata(page, pageSize, totalItems),
      items,
      truncated: sourceFields,
      truncation: { sourceFields },
    },
    null,
    2,
  );
}
