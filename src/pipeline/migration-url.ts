import type { WpAuthorSeoData } from "./blog-author-seo.js";
import type { TrackingRow } from "./types.js";

/** Source workbook column headers for the target Contentstack public path. */
export const NEW_URL_COLUMN_KEYS = new Set([
  "new_url",
  "new_url_path",
  "new_path",
  "destination_url",
  "contentstack_url",
  "cs_url",
]);

function normHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

/** Normalize to a path (`/articles/foo`), extracting pathname from full URLs. */
export function normalizeMigrationUrlPath(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) {
    try {
      const path = new URL(t).pathname.replace(/\/+/g, "/");
      return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path || "/";
    } catch {
      /* use as path below */
    }
  }
  const path = t.replace(/\/+/g, "/");
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function pickNewUrlFromSourceColumnsJson(sourceColumnsJson: string): string {
  const raw = sourceColumnsJson?.trim();
  if (!raw) return "";
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(o)) {
      if (!NEW_URL_COLUMN_KEYS.has(normHeader(key))) continue;
      const path = normalizeMigrationUrlPath(pickString(value));
      if (path) return path;
    }
  } catch {
    return "";
  }
  return "";
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Read `new_url` from the tracking row or `source_columns_json` fallback. */
export function pickNewUrlFromRow(row: Pick<TrackingRow, "new_url" | "source_columns_json">): string {
  const direct = normalizeMigrationUrlPath(row.new_url ?? "");
  if (direct) return direct;
  return pickNewUrlFromSourceColumnsJson(row.source_columns_json ?? "");
}

export type MigrationPageUrlSource = "new_url" | "fallback";

/** Target public path: sheet `new_url` when present, else slug/template fallback. */
export function resolveMigrationPageUrl(
  row: Pick<TrackingRow, "new_url" | "source_columns_json">,
  fallbackPath: string
): { path: string; source: MigrationPageUrlSource } {
  const fromSheet = pickNewUrlFromRow(row);
  if (fromSheet) return { path: fromSheet, source: "new_url" };
  return { path: normalizeMigrationUrlPath(fallbackPath), source: "fallback" };
}

export function withMigrationPageUrl(seo: WpAuthorSeoData, pageUrlPath: string): WpAuthorSeoData {
  const path = normalizeMigrationUrlPath(pageUrlPath);
  return {
    ...seo,
    pageUrlPath: path,
    canonicalPath: path,
  };
}
