import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export function escapedLikePattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/gu, "\\$&")}%`;
}

export function lowerLike(column: SQLWrapper, pattern: string): SQL {
  return sql`lower(${column}) LIKE ${pattern} ESCAPE '\\'`;
}
