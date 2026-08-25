export function activeViewQuery(url: URL): {
  readonly entity: string | null;
  readonly limit: number;
} {
  return {
    entity: url.searchParams.get("entity"),
    limit: Number(url.searchParams.get("limit")),
  };
}
