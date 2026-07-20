import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as XLSX from "xlsx";
import { loadPipelinePaths } from "../config-pipeline.js";
import {
  parseStorySheetColumnsFromRow,
  type StorySheetColumns,
} from "./blog-story-sheet.js";

export type BConnectedUpdateStatus = "Pass" | "Fail" | "Skipped" | "Pending";

export type BConnectedUpdateRow = {
  url: string;
  new_url: string;
  banner_image: string;
  l1: string;
  l2: string;
  l3: string;
  series: string;
  sheetCols: StorySheetColumns;
  contentstack_entry_uid: string;
  previous_url: string;
  update_status: BConnectedUpdateStatus;
  update_message: string;
  updated_at: string;
};

const DEFAULT_SHEET = "final";
const TRACKING_SHEET = "tracking";

function normHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/\.+/g, "_");
}

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

export function defaultBConnectedWorkbookPath(workbookName?: string): string {
  const paths = loadPipelinePaths();
  const fromArg = workbookName?.trim();
  const fromEnv = process.env.BCONNECTED_WORKBOOK?.trim();
  const fileName = fromArg || fromEnv || "b-connected.xlsx";
  if (isAbsolute(fileName)) return resolve(fileName);
  return resolve(dirname(paths.sourceWorkbook), fileName);
}

export function resolveBConnectedTabName(argvTab?: string): string {
  return (
    argvTab?.trim() ||
    process.env.BCONNECTED_TAB?.trim() ||
    DEFAULT_SHEET
  );
}

export function readBConnectedWorkbook(path: string, tabName: string): BConnectedUpdateRow[] {
  if (!existsSync(path)) {
    throw new Error(`B-connected workbook not found: ${path}`);
  }
  const wb = XLSX.read(readFileSync(path));
  const preferred =
    wb.Sheets[tabName] ??
    wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === tabName.toLowerCase()) ?? ""] ??
    wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === TRACKING_SHEET) ?? ""] ??
    wb.Sheets[wb.SheetNames[0]!];
  if (!preferred) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(preferred, { defval: "" });
  return rows
    .map((r) => {
      const sheetCols = parseStorySheetColumnsFromRow(r);
      return {
        url: pickCell(r, ["url", "current_url", "old_url", "cs_url", "contentstack_url"]),
        new_url: pickCell(r, ["new_url", "new url", "updated_url", "target_url"]),
        banner_image: pickCell(r, [
          "banner_image",
          "banner_image_uid",
          "banner_asset_uid",
          "banner",
        ]),
        l1: sheetCols.l1,
        l2: sheetCols.l2,
        l3: sheetCols.l3,
        series: sheetCols.series,
        sheetCols,
        contentstack_entry_uid: pickCell(r, [
          "contentstack_entry_uid",
          "uid",
          "entry_uid",
          "cs_uid",
        ]),
        previous_url: pickCell(r, ["previous_url"]),
        update_status: (pickCell(r, ["update_status", "status", "pass_fail", "pass/fail"]) ||
          "Pending") as BConnectedUpdateStatus,
        update_message: pickCell(r, ["update_message", "message"]),
        updated_at: pickCell(r, ["updated_at"]),
      } satisfies BConnectedUpdateRow;
    })
    .filter((r) => r.url.length > 0 || r.new_url.length > 0 || r.contentstack_entry_uid.length > 0);
}

/** Tracking workbook: url, new_url, contentstack_entry_uid, Pass/Fail (+ details). */
export function writeBConnectedStatusWorkbook(path: string, rows: BConnectedUpdateRow[]): void {
  const statusPath = bConnectedStatusWorkbookPath(path);
  const wb = XLSX.utils.book_new();
  const data = [
    [
      "url",
      "new_url",
      "contentstack_entry_uid",
      "update_status",
      "update_message",
      "previous_url",
      "l1",
      "l2",
      "l3",
      "series",
      "banner_image",
      "updated_at",
    ],
    ...rows.map((r) => [
      r.url,
      r.new_url,
      r.contentstack_entry_uid,
      r.update_status,
      r.update_message,
      r.previous_url,
      r.l1,
      r.l2,
      r.l3,
      r.series,
      r.banner_image,
      r.updated_at,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, TRACKING_SHEET);
  writeFileSync(statusPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

export function bConnectedStatusWorkbookPath(sourcePath: string): string {
  return sourcePath.replace(/\.xlsx$/i, "") + "-tracking.xlsx";
}
