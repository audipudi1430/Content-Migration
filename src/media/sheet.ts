import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { kindFromMimeType } from "./mime.js";
import { stripHtml } from "./utils.js";
import type { MediaSheetRow, WpMediaItem } from "./types.js";

const SHEET_NAME = "wp_media_mapping";

export function toSheetRow(item: WpMediaItem): MediaSheetRow {
  return {
    wp_id: item.id,
    mime_type: item.mime_type,
    media_kind: kindFromMimeType(item.mime_type),
    wp_slug: item.slug ?? "",
    wp_source_url: item.source_url ?? "",
    wp_title: item.title?.rendered ? stripHtml(item.title.rendered) : "",
    migration_status: "Pending",
    contentstack_uid: "",
    contentstack_type: "",
    migration_message: "",
    migrated_at: "",
  };
}

export function writeMediaSheet(path: string, rows: MediaSheetRow[]): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  XLSX.writeFile(wb, path);
}

export function readMediaSheet(path: string): MediaSheetRow[] {
  const wb = XLSX.read(readFileSync(path));
  const ws = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
  });
  return rows
    .map((r) => ({
      wp_id: Number(r.wp_id),
      mime_type: String(r.mime_type ?? ""),
      media_kind: String(r.media_kind ?? kindFromMimeType(String(r.mime_type ?? ""))) as MediaSheetRow["media_kind"],
      wp_slug: String(r.wp_slug ?? ""),
      wp_source_url: String(r.wp_source_url ?? ""),
      wp_title: String(r.wp_title ?? ""),
      migration_status: String(r.migration_status || "Pending") as MediaSheetRow["migration_status"],
      contentstack_uid: String(r.contentstack_uid ?? ""),
      contentstack_type: String(r.contentstack_type ?? ""),
      migration_message: String(r.migration_message ?? ""),
      migrated_at: String(r.migrated_at ?? ""),
    }))
    .filter((r) => Number.isFinite(r.wp_id) && r.wp_id > 0);
}

export function saveMediaSheet(path: string, rows: MediaSheetRow[]): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}
