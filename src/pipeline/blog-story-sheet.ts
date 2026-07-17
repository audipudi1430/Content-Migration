import { normalizeWpText } from "./contentstack-rte.js";
import type { TrackingRow } from "./types.js";

const HEADLINE_KEYS = new Set(["headline"]);
const NAMED_AUTHOR_KEYS = new Set(["named_author", "namedauthor"]);
const L1_KEYS = new Set(["l1", "l1_(category)", "l1_category", "l1_category_"]);
const L2_KEYS = new Set([
  "l2",
  "l2_values",
  "l2_values_(sub_category)",
  "l2_values_sub_category",
  "l2_values_(sub_category)_",
]);
const L3_KEYS = new Set([
  "l3",
  "l3_values",
  "l3_values_(blog_topics)",
  "l3_values_blog_topics",
  "l3_values_(blog_topics)_",
]);
const SERIES_KEYS = new Set(["series"]);

function normHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function pickFromRowObject(row: Record<string, unknown>, keys: Set<string>): string {
  for (const [key, value] of Object.entries(row)) {
    if (!keys.has(normHeader(key))) continue;
    return pickString(value);
  }
  return "";
}

function columnExistsInRow(row: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(row).some((key) => keys.has(normHeader(key)));
}

/** True when the sheet cell is empty, "None", "N/A", etc. */
export function isSheetNoneValue(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return !v || v === "none" || v === "null" || v === "n/a" || v === "na" || v === "-";
}

/** Split comma-separated labels; dedupe preserving order. */
export function parseCommaSeparatedLabels(raw: string): string[] {
  if (!raw.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const label = normalizeWpText(part.trim());
    if (!label || isSheetNoneValue(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

export type StorySheetColumns = {
  headline: string;
  namedAuthor: string;
  namedAuthorColumnPresent: boolean;
  l1: string;
  l1ColumnPresent: boolean;
  l2: string;
  l2ColumnPresent: boolean;
  series: string;
  seriesColumnPresent: boolean;
  l3: string;
  l3ColumnPresent: boolean;
};

/** Parse L1/L2/L3/Series (and related) columns from a raw Excel/JSON row object. */
export function parseStorySheetColumnsFromRow(o: Record<string, unknown>): StorySheetColumns {
  return {
    headline: normalizeWpText(pickFromRowObject(o, HEADLINE_KEYS)),
    namedAuthor: normalizeWpText(pickFromRowObject(o, NAMED_AUTHOR_KEYS)),
    namedAuthorColumnPresent: columnExistsInRow(o, NAMED_AUTHOR_KEYS),
    l1: pickFromRowObject(o, L1_KEYS),
    l1ColumnPresent: columnExistsInRow(o, L1_KEYS),
    l2: pickFromRowObject(o, L2_KEYS),
    l2ColumnPresent: columnExistsInRow(o, L2_KEYS),
    series: pickFromRowObject(o, SERIES_KEYS),
    seriesColumnPresent: columnExistsInRow(o, SERIES_KEYS),
    l3: pickFromRowObject(o, L3_KEYS),
    l3ColumnPresent: columnExistsInRow(o, L3_KEYS),
  };
}

export function parseStorySheetColumns(
  row: Pick<TrackingRow, "source_columns_json">
): StorySheetColumns {
  const empty: StorySheetColumns = {
    headline: "",
    namedAuthor: "",
    namedAuthorColumnPresent: false,
    l1: "",
    l1ColumnPresent: false,
    l2: "",
    l2ColumnPresent: false,
    series: "",
    seriesColumnPresent: false,
    l3: "",
    l3ColumnPresent: false,
  };

  const raw = row.source_columns_json?.trim();
  if (!raw) return empty;

  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return parseStorySheetColumnsFromRow(o);
  } catch {
    return empty;
  }
}

export function storySheetHasCategoryColumns(sheet: StorySheetColumns): boolean {
  return sheet.l1ColumnPresent || sheet.l2ColumnPresent || sheet.seriesColumnPresent;
}

/** All category/series labels from L1, L2, and Series columns (deduped). */
export function storySheetCategoryLabels(sheet: StorySheetColumns): string[] {
  const labels = [
    ...parseCommaSeparatedLabels(sheet.l1),
    ...parseCommaSeparatedLabels(sheet.l2),
    ...parseCommaSeparatedLabels(sheet.series),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
