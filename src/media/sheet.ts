import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { kindFromMimeType } from "./mime.js";
import { stripHtml } from "./utils.js";
import type { MediaSheetRow, WpMediaItem } from "./types.js";

const MAIN_SHEET = "main_mapping";
const LEGACY_SHEET = "wp_media_mapping";
const IMAGE_SHEET = "images";
const VIDEO_SHEET = "videos";
const DOCUMENT_SHEET = "documents";
const OTHER_SHEET = "others";

function tabForKind(kind: MediaSheetRow["media_kind"]): string {
  if (kind === "image") return IMAGE_SHEET;
  if (kind === "video") return VIDEO_SHEET;
  if (kind === "document") return DOCUMENT_SHEET;
  return OTHER_SHEET;
}

function normalizeRows(rows: MediaSheetRow[]): MediaSheetRow[] {
  return rows
    .map((r) => ({
      ...r,
      media_kind: kindFromMimeType(r.mime_type),
    }))
    .sort((a, b) => a.wp_id - b.wp_id);
}

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
  const normalized = normalizeRows(rows);
  const wb = XLSX.utils.book_new();
  appendAllSheets(wb, normalized);
  XLSX.writeFile(wb, path);
}

export function readMediaSheet(path: string): MediaSheetRow[] {
  const wb = XLSX.read(readFileSync(path));
  const ws = wb.Sheets[MAIN_SHEET] ?? wb.Sheets[LEGACY_SHEET] ?? wb.Sheets[wb.SheetNames[0]];
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
    .filter((r) => Number.isFinite(r.wp_id) && r.wp_id > 0)
    .sort((a, b) => a.wp_id - b.wp_id);
}

export function saveMediaSheet(path: string, rows: MediaSheetRow[]): void {
  const normalized = normalizeRows(rows);
  const wb = XLSX.utils.book_new();
  appendAllSheets(wb, normalized);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}

function appendAllSheets(wb: XLSX.WorkBook, rows: MediaSheetRow[]): void {
  const imageRows = rows.filter((r) => r.media_kind === "image");
  const videoRows = rows.filter((r) => r.media_kind === "video");
  const documentRows = rows.filter((r) => r.media_kind === "document");
  const otherRows = rows.filter((r) => r.media_kind === "other");

  const byTab = new Map<string, MediaSheetRow[]>([
    [IMAGE_SHEET, imageRows],
    [VIDEO_SHEET, videoRows],
    [DOCUMENT_SHEET, documentRows],
    [OTHER_SHEET, otherRows],
  ]);

  const byTabRowNum = new Map<string, Map<number, number>>();
  for (const [tab, tabRows] of byTab) {
    const rowNumMap = new Map<number, number>();
    tabRows.forEach((r, idx) => rowNumMap.set(r.wp_id, idx + 2));
    byTabRowNum.set(tab, rowNumMap);
  }

  const mainRows = rows.map((r) => ({
    ...r,
    target_tab: tabForKind(r.media_kind),
    open_tab: "",
    resolved_contentstack_uid: "",
    reference_value: "",
  }));
  const mainWs = XLSX.utils.json_to_sheet(mainRows);

  rows.forEach((r, idx) => {
    const rowNum = idx + 2;
    const targetTab = tabForKind(r.media_kind);
    const targetTabRowNum = byTabRowNum.get(targetTab)?.get(r.wp_id) ?? 2;

    // Excel shortcut to jump directly to the MIME-specific sheet row for this WP media id.
    mainWs[`M${rowNum}`] = { f: `HYPERLINK("#'${targetTab}'!A${targetTabRowNum}","Open")` };
    mainWs[`N${rowNum}`] = {
      f: `IFERROR(XLOOKUP(A${rowNum},INDIRECT("'${targetTab}'!A:A"),INDIRECT("'${targetTab}'!H:H"),""),"")`,
    };
    mainWs[`O${rowNum}`] = {
      f: `IF(N${rowNum}<>"","{""uid"":"""&N${rowNum}&"""}","")`,
    };
  });

  XLSX.utils.book_append_sheet(wb, mainWs, MAIN_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(imageRows), IMAGE_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(videoRows), VIDEO_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(documentRows), DOCUMENT_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(otherRows), OTHER_SHEET);
}
