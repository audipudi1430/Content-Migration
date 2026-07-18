import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as XLSX from "xlsx";
import { loadPipelinePaths } from "../config-pipeline.js";

export type StoryDatelineSheetStatus = "Pass" | "Fail" | "Skipped" | "Pending";

export type StoryDatelineSheetRow = {
  url: string;
  new_url: string;
  contentstack_entry_uid: string;
  wp_id: number;
  previous_dateline: string;
  new_dateline: string;
  update_status: StoryDatelineSheetStatus;
  update_message: string;
  updated_at: string;
};

const TRACKING_SHEET = "tracking";

function normHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
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

export function defaultStoryDatelineWorkbookPath(workbookName?: string): string {
  const paths = loadPipelinePaths();
  const fromArg = workbookName?.trim();
  const fromEnv = process.env.UPDATE_STORY_DATELINE_WORKBOOK?.trim();
  const fileName = fromArg || fromEnv || "story-dateline-updates.xlsx";
  if (isAbsolute(fileName)) return resolve(fileName);
  return resolve(dirname(paths.sourceWorkbook), fileName);
}

export function readStoryDatelineWorkbook(path: string, tabName?: string): StoryDatelineSheetRow[] {
  if (!existsSync(path)) {
    throw new Error(`Story dateline workbook not found: ${path}`);
  }
  const wb = XLSX.read(readFileSync(path));
  const preferredTab = tabName?.trim();
  const preferred =
    (preferredTab &&
      (wb.Sheets[preferredTab] ??
        wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === preferredTab.toLowerCase()) ?? ""])) ||
    wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === TRACKING_SHEET) ?? ""] ||
    wb.Sheets[wb.SheetNames[0]!];
  if (!preferred) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(preferred, { defval: "" });
  return rows
    .map((r) => ({
      url: pickCell(r, ["url", "wp_url", "wordpress_url", "source_url"]),
      new_url: pickCell(r, ["new_url", "new url", "cs_url", "contentstack_url", "updated_url"]),
      contentstack_entry_uid: pickCell(r, [
        "contentstack_entry_uid",
        "uid",
        "entry_uid",
        "cs_uid",
      ]),
      wp_id: Number(pickCell(r, ["wp_id", "id"])) || 0,
      previous_dateline: pickCell(r, ["previous_dateline"]),
      new_dateline: pickCell(r, ["new_dateline", "dateline"]),
      update_status: (pickCell(r, ["update_status", "status", "pass_fail", "pass/fail"]) ||
        "Pending") as StoryDatelineSheetStatus,
      update_message: pickCell(r, ["update_message", "message"]),
      updated_at: pickCell(r, ["updated_at"]),
    }))
    .filter((r) => r.url.length > 0 || r.new_url.length > 0);
}

export function storyDatelineStatusWorkbookPath(sourcePath: string): string {
  return sourcePath.replace(/\.xlsx$/i, "") + "-tracking.xlsx";
}

/** Tracking workbook: url, new_url, contentstack_entry_uid, Pass/Fail (+ details). */
export function writeStoryDatelineStatusWorkbook(
  sourcePath: string,
  rows: StoryDatelineSheetRow[]
): void {
  const statusPath = storyDatelineStatusWorkbookPath(sourcePath);
  const wb = XLSX.utils.book_new();
  const data = [
    [
      "url",
      "new_url",
      "contentstack_entry_uid",
      "update_status",
      "update_message",
      "previous_dateline",
      "new_dateline",
      "wp_id",
      "updated_at",
    ],
    ...rows.map((r) => [
      r.url,
      r.new_url,
      r.contentstack_entry_uid,
      r.update_status,
      r.update_message,
      r.previous_dateline,
      r.new_dateline,
      r.wp_id || "",
      r.updated_at,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, TRACKING_SHEET);
  writeFileSync(statusPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
