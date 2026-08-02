import { utf8ByteLength } from "../shared/utf8.ts";

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

export function boundedPaginatedOutput(input: {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly items: readonly unknown[];
  readonly maximumBytes: number;
  readonly page: number;
  readonly pageSize: number;
  readonly sourceFields: boolean;
  readonly tooLargeMessage: string;
  readonly totalItems: number;
}): string {
  const {
    fields = {},
    filters,
    items,
    maximumBytes,
    page,
    pageSize,
    sourceFields,
    tooLargeMessage,
    totalItems,
  } = input;
  return boundedJsonOutput(
    {
      ...fields,
      filters,
      ...paginationMetadata(page, pageSize, totalItems),
      items,
      truncated: sourceFields,
      truncation: { outputBytes: false, sourceFields },
    },
    maximumBytes,
    tooLargeMessage,
  );
}

function boundedJsonOutput(
  value: unknown,
  maximumBytes: number,
  tooLargeMessage: string,
): string {
  const output = JSON.stringify(value, null, 2);
  if (utf8ByteLength(output) > maximumBytes) {
    throw new Error(tooLargeMessage);
  }
  return output;
}
