import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

export type ContentVideoSheetRow = {
  url: string;
  wordpress_id: number;
  video_url: string;
  video_type: string;
  provider: string;
};

const HEADERS: (keyof ContentVideoSheetRow)[] = [
  "url",
  "wordpress_id",
  "video_url",
  "video_type",
  "provider",
];

export function defaultContentVideosWorkbookPath(tabName?: string): string {
  const fromEnv = process.env.MIGRATION_CONTENT_VIDEOS_WORKBOOK?.trim();
  if (fromEnv) return resolve(fromEnv);
  const safeTab = tabName?.trim().replace(/[^\w.-]+/g, "_") || "content";
  return resolve(`content-videos-${safeTab}.xlsx`);
}

export function writeContentVideosWorkbook(
  path: string,
  sheetName: string,
  rows: ContentVideoSheetRow[]
): void {
  const wb = XLSX.utils.book_new();
  const data = [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h]))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "videos");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}
