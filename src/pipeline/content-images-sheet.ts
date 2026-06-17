import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

export type ContentImageSheetRow = {
  url: string;
  wordpress_id: number;
  media_wordpress_id: string;
  media_url: string;
  Size: string;
  "OK/Not OK": string;
};

const HEADERS: (keyof ContentImageSheetRow)[] = [
  "url",
  "wordpress_id",
  "media_wordpress_id",
  "media_url",
  "Size",
  "OK/Not OK",
];

export function defaultContentImagesWorkbookPath(tabName?: string): string {
  const fromEnv = process.env.MIGRATION_CONTENT_IMAGES_WORKBOOK?.trim();
  if (fromEnv) return resolve(fromEnv);
  const safeTab = tabName?.trim().replace(/[^\w.-]+/g, "_") || "content";
  return resolve(`content-images-${safeTab}.xlsx`);
}

export function writeContentImagesWorkbook(
  path: string,
  sheetName: string,
  rows: ContentImageSheetRow[]
): void {
  const wb = XLSX.utils.book_new();
  const data = [
    HEADERS,
    ...rows.map((r) => HEADERS.map((h) => r[h])),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "images");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}
