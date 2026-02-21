export type SortOrder = "asc" | "desc";

export interface PaginationInput {
  cursor?: string;
  limit?: number;
  maxResults?: number;
  sort?: SortOrder;
}

export interface PaginationResult {
  pageUids: number[];
  nextCursor?: string;
  sort: SortOrder;
  limit: number;
}

export function normalizeSort(sort: unknown): SortOrder {
  return sort === "asc" ? "asc" : "desc";
}

export function clampLimit(
  value: unknown,
  maxResults: number,
  defaultLimit: number = 50
): number {
  const fallback = Number.isFinite(defaultLimit) ? Math.max(1, Math.floor(defaultLimit)) : 50;
  const cap = Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : 200;
  const n = typeof value === "number" ? value : fallback;
  const normalized = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
  return Math.min(normalized, cap);
}

export function encodeCursor(uid: number): string {
  return Buffer.from(String(uid), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8").trim();
  } catch {
    throw new Error("Invalid cursor value");
  }
  const n = Number(decoded);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid cursor value");
  }
  return n;
}

export function paginateUids(
  matchedUids: number[],
  input: PaginationInput = {}
): PaginationResult {
  const sort = normalizeSort(input.sort);
  const limit = clampLimit(input.limit, input.maxResults ?? 200, 50);
  const uniqueAsc = Array.from(new Set(matchedUids)).filter((v) => v > 0).sort((a, b) => a - b);
  const cursorUid = decodeCursor(input.cursor);

  let ordered = sort === "asc" ? uniqueAsc : uniqueAsc.slice().reverse();
  if (cursorUid != null) {
    ordered = sort === "asc" ? ordered.filter((uid) => uid > cursorUid) : ordered.filter((uid) => uid < cursorUid);
  }

  const pageUids = ordered.slice(0, limit);
  const hasMore = ordered.length > pageUids.length;
  const nextCursor = hasMore && pageUids.length > 0 ? encodeCursor(pageUids[pageUids.length - 1]) : undefined;
  return { pageUids, nextCursor, sort, limit };
}

export function toSnippet(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (maxLength <= 0 || normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength) + "...";
}
