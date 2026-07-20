import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as XLSX from "xlsx";
import { loadPipelinePaths } from "../config-pipeline.js";
import {
  parseStorySheetColumnsFromRow,
  type StorySheetColumns,
} from "./blog-story-sheet.js";

export type BConnectedUpdateStatus =
  | "Pass"
  | "Fail"
  | "Skipped"
  | "Pending"
  | "Already Updated";

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

const DONE_STATUSES = new Set<string>(["Pass", "Already Updated"]);

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

export function bConnectedStatusWorkbookPath(sourcePath: string): string {
  return sourcePath.replace(/\.xlsx$/i, "") + "-tracking.xlsx";
}

export function isBConnectedPending(row: BConnectedUpdateRow): boolean {
  const s = (row.update_status || "Pending").trim();
  if (!s || s === "Pending" || s === "Fail") return true;
  return !DONE_STATUSES.has(s) && s !== "Skipped";
}

function rowMatchKey(url: string, newUrl: string): string {
  return `${url.trim().toLowerCase()}||${newUrl.trim().toLowerCase()}`;
}

function parseStatus(raw: string): BConnectedUpdateStatus {
  const s = raw.trim();
  if (s === "Pass") return "Pass";
  if (s === "Fail") return "Fail";
  if (s === "Skipped") return "Skipped";
  if (s === "Already Updated" || s === "AlreadyUpdated" || s === "already_updated") {
    return "Already Updated";
  }
  return "Pending";
}

function mapRawToRow(r: Record<string, unknown>): BConnectedUpdateRow {
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
    update_status: parseStatus(
      pickCell(r, ["update_status", "status", "pass_fail", "pass/fail"])
    ),
    update_message: pickCell(r, ["update_message", "message"]),
    updated_at: pickCell(r, ["updated_at"]),
  };
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
    .map(mapRawToRow)
    .filter((r) => r.url.length > 0 || r.new_url.length > 0 || r.contentstack_entry_uid.length > 0);
}

/** Merge prior *-tracking.xlsx status/uid into input rows so re-runs only hit pending. */
export function mergeBConnectedPriorTracking(
  sourcePath: string,
  rows: BConnectedUpdateRow[]
): number {
  const trackingPath = bConnectedStatusWorkbookPath(sourcePath);
  if (!existsSync(trackingPath)) return 0;

  const wb = XLSX.read(readFileSync(trackingPath));
  const sheet =
    wb.Sheets[TRACKING_SHEET] ??
    wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === TRACKING_SHEET) ?? ""] ??
    wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return 0;

  const prior = XLSX.utils
    .sheet_to_json<Record<string, unknown>>(sheet, { defval: "" })
    .map(mapRawToRow);

  const byKey = new Map<string, BConnectedUpdateRow>();
  const byUid = new Map<string, BConnectedUpdateRow>();
  for (const p of prior) {
    byKey.set(rowMatchKey(p.url, p.new_url), p);
    if (p.contentstack_entry_uid) byUid.set(p.contentstack_entry_uid, p);
  }

  let merged = 0;
  for (const row of rows) {
    const priorRow =
      byKey.get(rowMatchKey(row.url, row.new_url)) ||
      (row.contentstack_entry_uid ? byUid.get(row.contentstack_entry_uid) : undefined);
    if (!priorRow) continue;
    if (priorRow.contentstack_entry_uid && !row.contentstack_entry_uid) {
      row.contentstack_entry_uid = priorRow.contentstack_entry_uid;
    }
    if (priorRow.update_status && priorRow.update_status !== "Pending") {
      row.update_status = priorRow.update_status;
      row.update_message = priorRow.update_message || row.update_message;
      row.previous_url = priorRow.previous_url || row.previous_url;
      row.updated_at = priorRow.updated_at || row.updated_at;
      merged += 1;
    } else if (priorRow.contentstack_entry_uid) {
      merged += 1;
    }
  }
  return merged;
}

/** Tracking workbook: url, new_url, contentstack_entry_uid, Pass/Fail/Already Updated. */
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
