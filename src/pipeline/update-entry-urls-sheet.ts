import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as XLSX from "xlsx";
import { loadPipelinePaths } from "../config-pipeline.js";

export type EntryUrlUpdateStatus = "Pass" | "Fail" | "Skipped" | "Pending";

export type EntryUrlUpdateRow = {
  uid: string;
  content_type_uid: string;
  locale: string;
  title: string;
  url: string;
  seo_page_url_canonical: string;
  updated_url: string;
  previous_url: string;
  previous_canonical: string;
  update_status: EntryUrlUpdateStatus;
  update_message: string;
  updated_at: string;
};

const SHEET_NAME = "entry_url_updates";

function normHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/\.+/g, "_");
}

/** Map common Excel header aliases onto our row keys. */
function pickCell(row: Record<string, unknown>, aliases: string[]): string {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    byNorm.set(normHeader(k), v);
  }
  for (const alias of aliases) {
    const v = byNorm.get(normHeader(alias));
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

export function defaultEntryUrlUpdateWorkbookPath(workbookName?: string): string {
  const paths = loadPipelinePaths();
  const fromArg = workbookName?.trim();
  const fromEnv = process.env.UPDATE_ENTRY_URL_WORKBOOK?.trim();
  const fileName = fromArg || fromEnv || "entry-url-updates.xlsx";
  if (isAbsolute(fileName)) return resolve(fileName);
  return resolve(dirname(paths.sourceWorkbook), fileName);
}

export function readEntryUrlUpdateWorkbook(path: string): EntryUrlUpdateRow[] {
  if (!existsSync(path)) {
    throw new Error(`Entry URL update workbook not found: ${path}`);
  }
  const wb = XLSX.read(readFileSync(path));
  const preferred =
    wb.Sheets[SHEET_NAME] ??
    wb.Sheets["url_updates"] ??
    wb.Sheets[wb.SheetNames[0]!];
  if (!preferred) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(preferred, { defval: "" });
  return rows
    .map((r) => {
      const uid = pickCell(r, [
        "uid",
        "contentstack_entry_uid",
        "entry_uid",
        "cs_uid",
        "contentstack_uid",
      ]);
      const updated_url = pickCell(r, [
        "updated_url",
        "new_url",
        "target_url",
        "destination_url",
      ]);
      const seoCanonical = pickCell(r, [
        "seo_page_url_canonical",
        "seo.page_url.canonical",
        "seo_page_url_canonical",
        "page_url_canonical",
        "canonical",
      ]);
      return {
        uid,
        content_type_uid: pickCell(r, [
          "content_type_uid",
          "content_type",
          "contentstack_content_type",
          "ct_uid",
        ]),
        locale: pickCell(r, ["locale", "contentstack_locale"]),
        title: pickCell(r, ["title", "entry_title", "name"]),
        url: pickCell(r, ["url", "current_url", "old_url"]),
        seo_page_url_canonical: seoCanonical,
        updated_url,
        previous_url: pickCell(r, ["previous_url"]),
        previous_canonical: pickCell(r, ["previous_canonical"]),
        update_status: (pickCell(r, ["update_status", "status"]) ||
          "Pending") as EntryUrlUpdateStatus,
        update_message: pickCell(r, ["update_message", "message"]),
        updated_at: pickCell(r, ["updated_at"]),
      } satisfies EntryUrlUpdateRow;
    })
    .filter((r) => r.uid.length > 0 || r.updated_url.length > 0);
}

export function writeEntryUrlUpdateWorkbook(path: string, rows: EntryUrlUpdateRow[]): void {
  const wb = XLSX.utils.book_new();
  const data = [
    [
      "uid",
      "content_type_uid",
      "locale",
      "title",
      "url",
      "seo.page_url.canonical",
      "updated_url",
      "previous_url",
      "previous_canonical",
      "update_status",
      "update_message",
      "updated_at",
    ],
    ...rows.map((r) => [
      r.uid,
      r.content_type_uid,
      r.locale,
      r.title,
      r.url,
      r.seo_page_url_canonical,
      r.updated_url,
      r.previous_url,
      r.previous_canonical,
      r.update_status,
      r.update_message,
      r.updated_at,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}
