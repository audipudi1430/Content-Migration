import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

export type FolderImageUploadStatus = "Pass" | "Fail" | "Skipped";

export type FolderImageUploadRow = {
  local_path: string;
  relative_path: string;
  filename: string;
  file_size_bytes: number;
  mime_type: string;
  contentstack_folder_uid: string;
  contentstack_folder_path: string;
  contentstack_asset_uid: string;
  compressed: string;
  original_size: string;
  output_size: string;
  upload_status: FolderImageUploadStatus;
  upload_message: string;
  uploaded_at: string;
};

const HEADERS: (keyof FolderImageUploadRow)[] = [
  "local_path",
  "relative_path",
  "filename",
  "file_size_bytes",
  "mime_type",
  "contentstack_folder_uid",
  "contentstack_folder_path",
  "contentstack_asset_uid",
  "compressed",
  "original_size",
  "output_size",
  "upload_status",
  "upload_message",
  "uploaded_at",
];

const SHEET_NAME = "folder_image_uploads";

export function defaultFolderImagesWorkbookPath(): string {
  const fromEnv = process.env.FOLDER_IMAGES_TRACKING_WORKBOOK?.trim();
  return resolve(fromEnv || "folder-image-uploads.xlsx");
}

export function readFolderImagesWorkbook(path: string): FolderImageUploadRow[] {
  if (!existsSync(path)) return [];
  const wb = XLSX.read(readFileSync(path));
  const ws = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]!];
  if (!ws) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  return rows
    .map((r) => ({
      local_path: String(r.local_path ?? ""),
      relative_path: String(r.relative_path ?? ""),
      filename: String(r.filename ?? ""),
      file_size_bytes: Number(r.file_size_bytes) || 0,
      mime_type: String(r.mime_type ?? ""),
      contentstack_folder_uid: String(r.contentstack_folder_uid ?? ""),
      contentstack_folder_path: String(r.contentstack_folder_path ?? ""),
      contentstack_asset_uid: String(r.contentstack_asset_uid ?? ""),
      compressed: String(r.compressed ?? ""),
      original_size: String(r.original_size ?? ""),
      output_size: String(r.output_size ?? ""),
      upload_status: (String(r.upload_status ?? "Pending") || "Pending") as FolderImageUploadStatus,
      upload_message: String(r.upload_message ?? ""),
      uploaded_at: String(r.uploaded_at ?? ""),
    }))
    .filter((r) => r.relative_path.length > 0);
}

export function writeFolderImagesWorkbook(path: string, rows: FolderImageUploadRow[]): void {
  const wb = XLSX.utils.book_new();
  const data = [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h]))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  writeFileSync(path, buffer);
}

export function upsertFolderImageRow(
  rows: FolderImageUploadRow[],
  row: FolderImageUploadRow
): FolderImageUploadRow[] {
  const key = row.relative_path.replace(/\\/g, "/");
  const idx = rows.findIndex((r) => r.relative_path.replace(/\\/g, "/") === key);
  if (idx === -1) return [...rows, row];
  const next = [...rows];
  next[idx] = row;
  return next;
}
