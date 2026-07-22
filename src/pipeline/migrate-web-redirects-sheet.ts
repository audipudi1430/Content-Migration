import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as XLSX from "xlsx";
import { loadPipelinePaths } from "../config-pipeline.js";

export type WebRedirectStatus = "Pass" | "Fail" | "Skipped" | "Pending";

export type WebRedirectRow = {
  title: string;
  url: string;
  new_url: string;
  contentstack_entry_uid: string;
  update_status: WebRedirectStatus;
  update_message: string;
  updated_at: string;
};

const DEFAULT_WORKBOOK = "web-redirects.xlsx";
const DEFAULT_TAB = "web-redirects";
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

function parseStatus(raw: string): WebRedirectStatus {
  const s = raw.trim();
  if (s === "Pass") return "Pass";
  if (s === "Fail") return "Fail";
  if (s === "Skipped") return "Skipped";
  return "Pending";
}

function mapRawToRow(r: Record<string, unknown>): WebRedirectRow {
  return {
    title: pickCell(r, ["title", "name"]),
    url: pickCell(r, ["url", "redirect_condition", "from", "source_url"]),
    new_url: pickCell(r, ["new_url", "new url", "redirect_mapping", "to", "target_url"]),
    contentstack_entry_uid: pickCell(r, [
      "contentstack_entry_uid",
      "uid",
      "entry_uid",
      "cs_uid",
    ]),
    update_status: parseStatus(
      pickCell(r, ["update_status", "status", "pass_fail", "pass/fail"])
    ),
    update_message: pickCell(r, ["update_message", "message"]),
    updated_at: pickCell(r, ["updated_at"]),
  };
}

export function defaultWebRedirectWorkbookPath(workbookName?: string): string {
  const paths = loadPipelinePaths();
  const fromArg = workbookName?.trim();
  const fromEnv = process.env.WEB_REDIRECT_WORKBOOK?.trim();
  const fileName = fromArg || fromEnv || DEFAULT_WORKBOOK;
  if (isAbsolute(fileName)) return resolve(fileName);
  return resolve(dirname(paths.sourceWorkbook), fileName);
}

export function resolveWebRedirectTabName(argvTab?: string): string {
  return (
    argvTab?.trim() ||
    process.env.WEB_REDIRECT_TAB?.trim() ||
    DEFAULT_TAB
  );
}

export function webRedirectTrackingWorkbookPath(sourcePath: string): string {
  return sourcePath.replace(/\.xlsx$/i, "") + "-tracking.xlsx";
}

export function isWebRedirectPending(row: WebRedirectRow): boolean {
  const s = (row.update_status || "Pending").trim();
  return !s || s === "Pending" || s === "Fail";
}

function rowMatchKey(title: string, url: string, newUrl: string): string {
  return `${title.trim().toLowerCase()}||${url.trim().toLowerCase()}||${newUrl.trim().toLowerCase()}`;
}

export function readWebRedirectWorkbook(path: string, tabName: string): WebRedirectRow[] {
  if (!existsSync(path)) {
    throw new Error(`Web redirects workbook not found: ${path}`);
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
    .filter((r) => r.title.length > 0 || r.url.length > 0 || r.new_url.length > 0);
}

/** Merge prior *-tracking.xlsx so re-runs only process Pending/Fail. */
export function mergeWebRedirectPriorTracking(
  sourcePath: string,
  rows: WebRedirectRow[]
): number {
  const trackingPath = webRedirectTrackingWorkbookPath(sourcePath);
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

  const byKey = new Map<string, WebRedirectRow>();
  const byUid = new Map<string, WebRedirectRow>();
  for (const p of prior) {
    byKey.set(rowMatchKey(p.title, p.url, p.new_url), p);
    if (p.contentstack_entry_uid) byUid.set(p.contentstack_entry_uid, p);
  }

  let merged = 0;
  for (const row of rows) {
    const priorRow =
      byKey.get(rowMatchKey(row.title, row.url, row.new_url)) ||
      (row.contentstack_entry_uid ? byUid.get(row.contentstack_entry_uid) : undefined);
    if (!priorRow) continue;
    if (priorRow.contentstack_entry_uid && !row.contentstack_entry_uid) {
      row.contentstack_entry_uid = priorRow.contentstack_entry_uid;
    }
    if (priorRow.update_status && priorRow.update_status !== "Pending") {
      row.update_status = priorRow.update_status;
      row.update_message = priorRow.update_message || row.update_message;
      row.updated_at = priorRow.updated_at || row.updated_at;
      merged += 1;
    } else if (priorRow.contentstack_entry_uid) {
      merged += 1;
    }
  }
  return merged;
}

export function writeWebRedirectTrackingWorkbook(
  sourcePath: string,
  rows: WebRedirectRow[]
): void {
  const statusPath = webRedirectTrackingWorkbookPath(sourcePath);
  const wb = XLSX.utils.book_new();
  const data = [
    [
      "title",
      "url",
      "new_url",
      "contentstack_entry_uid",
      "update_status",
      "update_message",
      "updated_at",
    ],
    ...rows.map((r) => [
      r.title,
      r.url,
      r.new_url,
      r.contentstack_entry_uid,
      r.update_status,
      r.update_message,
      r.updated_at,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, TRACKING_SHEET);
  writeFileSync(statusPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
