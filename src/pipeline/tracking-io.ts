import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { trackingRowStableMergeKey } from "../mongo/tracking-repository.js";
import type { TrackingRow } from "./types.js";

function rowFromRecord(r: Record<string, unknown>): TrackingRow {
  return {
    source_sheet: String(r.source_sheet ?? ""),
    row_kind: (String(r.row_kind ?? "content") === "media" ? "media" : "content") as TrackingRow["row_kind"],
    url: String(r.url ?? ""),
    wp_id: Number(r.wp_id) || 0,
    wp_rest_path: String(r.wp_rest_path ?? ""),
    content_type_uid: String(r.content_type_uid ?? ""),
    featured_media_wp_id: String(r.featured_media_wp_id ?? ""),
    migration_status: (String(r.migration_status || "Pending") || "Pending") as TrackingRow["migration_status"],
    publish_status: (String(r.publish_status || "Unpublished") || "Unpublished") as TrackingRow["publish_status"],
    contentstack_entry_uid: String(r.contentstack_entry_uid ?? ""),
    contentstack_asset_uid: String(r.contentstack_asset_uid ?? ""),
    migration_message: String(r.migration_message ?? ""),
    published_at: String(r.published_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    source_columns_json: String(r.source_columns_json ?? ""),
    extracted_at: String(r.extracted_at ?? ""),
    target_url: String(r.target_url ?? ""),
    wp_slug: String(r.wp_slug ?? ""),
    wp_title: String(r.wp_title ?? ""),
    wp_status: String(r.wp_status ?? ""),
    wp_type: String(r.wp_type ?? ""),
    wp_link: String(r.wp_link ?? ""),
    wp_extract_json: String(r.wp_extract_json ?? ""),
  };
}

export function readTrackingSheet(path: string, sheetName: string): TrackingRow[] {
  if (!existsSync(path)) return [];
  const wb = XLSX.read(readFileSync(path));
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  return rows.map(rowFromRecord).filter((r) => r.url.length > 0 || r.wp_id > 0);
}

export function writeTrackingSheet(path: string, sheetName: string, rows: TrackingRow[]): void {
  const wb = existsSync(path) ? XLSX.read(readFileSync(path)) : XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  if (wb.SheetNames.includes(sheetName)) {
    const idx = wb.SheetNames.indexOf(sheetName);
    delete wb.Sheets[sheetName];
    wb.SheetNames.splice(idx, 1);
  }
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  writeFileSync(path, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

export function mergeTrackingRows(existing: TrackingRow[], incoming: TrackingRow[]): TrackingRow[] {
  const key = (r: TrackingRow) => trackingRowStableMergeKey(r.source_sheet, r.row_kind, r.wp_id, r.url);
  const map = new Map<string, TrackingRow>();
  for (const r of existing) map.set(key(r), r);
  for (const r of incoming) {
    const k = key(r);
    const prev = map.get(k);
    if (prev) {
      const keepProgress = prev.migration_status === "Pass" || prev.migration_status === "Skipped";
      map.set(k, {
        ...r,
        migration_status: keepProgress ? prev.migration_status : r.migration_status,
        publish_status: prev.publish_status === "Published" ? prev.publish_status : r.publish_status,
        contentstack_entry_uid: keepProgress ? prev.contentstack_entry_uid : r.contentstack_entry_uid,
        contentstack_asset_uid: keepProgress ? prev.contentstack_asset_uid : r.contentstack_asset_uid,
        migration_message: keepProgress ? prev.migration_message : r.migration_message,
        target_url: keepProgress ? prev.target_url : r.target_url,
        source_columns_json: r.source_columns_json,
        extracted_at: r.extracted_at,
        wp_slug: r.wp_slug,
        wp_title: r.wp_title,
        wp_status: r.wp_status,
        wp_type: r.wp_type,
        wp_link: r.wp_link,
        wp_extract_json: r.wp_extract_json,
        published_at: prev.published_at || r.published_at,
        updated_at: r.updated_at,
      });
    } else {
      map.set(k, r);
    }
  }
  return [...map.values()].sort((a, b) => {
    const s = a.source_sheet.localeCompare(b.source_sheet);
    if (s !== 0) return s;
    return a.wp_id - b.wp_id;
  });
}
