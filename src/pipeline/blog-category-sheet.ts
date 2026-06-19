import { createHash } from "node:crypto";
import { normalizeMigrationUrlPath, pickNewUrlFromRow } from "./migration-url.js";
import type { TrackingRow } from "./types.js";
import type { WpStoryCategory } from "./blog-category-seo.js";

export type CategorySheetColumns = {
  categoryName: string;
  showUrl: "yes" | "no";
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

/** Contentstack `show_url` enum: `yes` when sheet Is Page is yes; otherwise `no`. */
export function showUrlFromIsPage(raw: string): "yes" | "no" {
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true" || v === "1") return "yes";
  return "no";
}

export function pickCategoryNameFromRowObject(row: Record<string, string>): string {
  const o: Record<string, unknown> = row;
  return pickFromRowObject(o, CATEGORY_NAME_KEYS);
}

export function isBlogCategoryExtractTab(
  contentTypeUid: string,
  wpRestPath: string,
  sourceSheet?: string
): boolean {
  const ct = contentTypeUid.trim().toLowerCase();
  if (ct === "blog_category" || ct.endsWith("blog_category")) return true;
  if (ct === "story_category" || ct.endsWith("story_category")) return true;
  if (wpRestPath.toLowerCase().includes("story_category")) return true;
  const tab = sourceSheet?.trim().toLowerCase() ?? "";
  if (tab === "categories" || tab === "category" || tab === "blog_categories") return true;
  if (tab.includes("categor")) return true;
  return false;
}

export function isCategorySourceSheetRow(
  row: Pick<TrackingRow, "source_sheet" | "content_type_uid" | "wp_rest_path">
): boolean {
  return isBlogCategoryExtractTab(row.content_type_uid, row.wp_rest_path, row.source_sheet);
}

export function categoryRowHasSheetData(
  row: Pick<TrackingRow, "source_columns_json" | "new_url">
): boolean {
  const sheet = parseCategorySheetColumns(row);
  return Boolean(sheet.categoryName || pickNewUrlFromRow(row));
}

/** Sheet-only row: no WordPress URL (create entry from Category Name + new_url, wp_id stays 0). */
export function isSheetOnlyCategoryRow(
  row: Pick<TrackingRow, "wp_id" | "url">
): boolean {
  return row.wp_id === 0 && !trackingRowHasSourceUrl(row);
}

/** Unique tracking merge key segment when wp_id=0 and no source URL. */
export function categoryRowDisambiguator(
  row: Pick<TrackingRow, "source_columns_json" | "new_url">
): string {
  const newUrl = pickNewUrlFromRow(row);
  if (newUrl) return `new:${normalizeMigrationUrlPath(newUrl)}`;
  const name = parseCategorySheetColumns(row).categoryName;
  if (name) {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return `cat:${slug}`;
  }
  const raw = row.source_columns_json?.trim() || "";
  const h = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `row:${h}`;
}

/** Map key for wp_id=0 categories (new_url path or slug). */
export function categoryMappingSourceKey(
  row: Pick<TrackingRow, "source_columns_json" | "new_url">,
  slug: string
): string {
  const newUrl = pickNewUrlFromRow(row);
  if (newUrl) return newUrl;
  return slug;
}

function slugifyCategoryName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugFromMigrationPath(path: string): string {
  const segs = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

export function buildSheetOnlyCategoryTerm(trackRef: TrackingRow): WpStoryCategory {
  const sheet = parseCategorySheetColumns(trackRef);
  const name = sheet.categoryName || "Category";
  const newUrl = pickNewUrlFromRow(trackRef);
  const slug =
    slugFromMigrationPath(newUrl) ||
    slugifyCategoryName(name) ||
    "category";
  return {
    id: 0,
    name,
    slug,
    link: newUrl || undefined,
  };
}

export function parseCategorySheetColumns(
  row: Pick<TrackingRow, "source_columns_json">
): CategorySheetColumns {
  const empty: CategorySheetColumns = {
    categoryName: "",
    showUrl: "no",
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
