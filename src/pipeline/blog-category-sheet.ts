import type { TrackingRow } from "./types.js";

export type CategorySheetColumns = {
  categoryName: string;
  showUrl: "Yes" | "No";
  categoryLevel: string;
  isPageRaw: string;
  levelRaw: string;
};

const CATEGORY_NAME_KEYS = new Set([
  "category_name",
  "categoryname",
  "catgeory_name",
  "catgeoryname",
  "name",
]);

const IS_PAGE_KEYS = new Set(["is_page", "ispage", "is page"]);

const LEVEL_KEYS = new Set(["level", "category_level"]);

const LEVEL_VALUE_MAP: Record<string, string> = {
  l1: "level1",
  level1: "level1",
  "level 1": "level1",
  l2: "level2",
  level2: "level2",
  "level 2": "level2",
  series: "series",
  industry: "industry",
};

function normHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function pickFromRowObject(
  row: Record<string, unknown>,
  keys: Set<string>
): string {
  for (const [key, value] of Object.entries(row)) {
    if (!keys.has(normHeader(key))) continue;
    const s = pickString(value);
    if (s) return s;
  }
  return "";
}

export function mapCategoryLevel(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!key) return "";
  return LEVEL_VALUE_MAP[key] ?? "";
}

export function showUrlFromIsPage(raw: string): "Yes" | "No" {
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true" || v === "1") return "Yes";
  return "No";
}

export function parseCategorySheetColumns(
  row: Pick<TrackingRow, "source_columns_json">
): CategorySheetColumns {
  const empty: CategorySheetColumns = {
    categoryName: "",
    showUrl: "No",
    categoryLevel: "",
    isPageRaw: "",
    levelRaw: "",
  };

  const raw = row.source_columns_json?.trim();
  if (!raw) return empty;

  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const categoryName = pickFromRowObject(o, CATEGORY_NAME_KEYS);
    const isPageRaw = pickFromRowObject(o, IS_PAGE_KEYS);
    const levelRaw = pickFromRowObject(o, LEVEL_KEYS);
    return {
      categoryName,
      showUrl: showUrlFromIsPage(isPageRaw),
      categoryLevel: mapCategoryLevel(levelRaw),
      isPageRaw,
      levelRaw,
    };
  } catch {
    return empty;
  }
}

/** True when the tracking row has a WordPress source URL (REST fetch expected). */
export function trackingRowHasSourceUrl(row: Pick<TrackingRow, "url">): boolean {
  return Boolean(row.url?.trim());
}
