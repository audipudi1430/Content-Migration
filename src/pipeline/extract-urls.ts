import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  contentTypeUidForSourceTab,
  loadMongoConfig,
  loadPipelinePaths,
  wpRestPathForSourceTab,
} from "../config-pipeline.js";
import { upsertTrackingDoc, getTrackingCollection, closeMongo } from "../mongo/tracking-repository.js";
import { mergeTrackingRows, readTrackingSheet, writeTrackingSheet } from "./tracking-io.js";
import { emptyTrackingRow, type TrackingRow, type TrackingRowKind } from "./types.js";
import { stringArg } from "./args.js";
import { trackingRowToMongoDoc } from "./tracking-sync.js";

function normHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

function inferWpIdFromUrl(url: string): number | undefined {
  const t = url.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    const p = u.searchParams.get("p");
    if (p) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const att = u.searchParams.get("attachment_id");
    if (att) {
      const n = Number(att);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const URL_KEYS = new Set(["url", "link", "permalink", "post_url", "page_url", "source_url", "href"]);
const ID_KEYS = new Set([
  "wp_id",
  "wordpress_id",
  "post_id",
  "page_id",
  "id",
  "wordpress_post_id",
  "media_id",
]);

function pickColumn(headers: string[], keys: Set<string>): string | undefined {
  for (const h of headers) {
    const n = normHeader(h);
    if (keys.has(n)) return h;
  }
  for (const h of headers) {
    const n = normHeader(h);
    if (keys.has(n.replace(/^wp_/, ""))) return h;
  }
  return undefined;
}

function rowObjectFromMatrix(headerRow: string[], line: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let j = 0; j < headerRow.length; j++) {
    const key = String(headerRow[j] ?? "").trim();
    if (!key) continue;
    o[key] = String(line[j] ?? "").trim();
  }
  return o;
}

function captureSourceColumnsJson(o: Record<string, string>, maxLen = 100_000): string {
  if (Object.keys(o).length === 0) return "{}";
  let cur: Record<string, string> = { ...o };
  let raw = JSON.stringify(cur);
  while (raw.length > maxLen && Object.keys(cur).length > 0) {
    const ks = Object.keys(cur);
    const drop = ks[ks.length - 1]!;
    const { [drop]: _, ...rest } = cur;
    cur = rest;
    raw = JSON.stringify(cur);
  }
  if (raw.length > maxLen) {
    return JSON.stringify({ _truncated: "true", _approx_len: String(JSON.stringify(o).length) });
  }
  return raw;
}

function sheetToMatrix(ws: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];
}

function parseSheetRows(
  sheetName: string,
  matrix: string[][],
  rowKind: TrackingRowKind,
  wpRestPath: string,
  contentTypeUid: string
): { rows: TrackingRow[]; missingIdUrls: string[] } {
  const missingIdUrls: string[] = [];
  if (matrix.length === 0) return { rows: [], missingIdUrls };
  const headerRow = matrix[0].map((c) => String(c));
  const headers = headerRow.filter(Boolean);
  const urlCol = pickColumn(headers, URL_KEYS);
  const idCol = pickColumn(headers, ID_KEYS);
  const colIndex = (name: string | undefined) => {
    if (!name) return -1;
    return headerRow.findIndex((c) => String(c).trim() === name);
  };
  const urlIdx = colIndex(urlCol);
  const idIdx = colIndex(idCol);
  const rows: TrackingRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const line = matrix[i];
    if (!line || line.every((c) => !String(c).trim())) continue;
    const url = urlIdx >= 0 ? String(line[urlIdx] ?? "").trim() : "";
    let wpId = idIdx >= 0 ? Number(String(line[idIdx] ?? "").trim()) : NaN;
    if (!Number.isFinite(wpId) || wpId <= 0) {
      const inferred = inferWpIdFromUrl(url);
      if (inferred) wpId = inferred;
    }
    const rowObject = rowObjectFromMatrix(headerRow, line);
    const sourceColumnsJson = captureSourceColumnsJson(rowObject);
    const extractedAt = new Date().toISOString();
    if (!Number.isFinite(wpId) || wpId <= 0) {
      if (url) missingIdUrls.push(url);
      rows.push(
        emptyTrackingRow({
          source_sheet: sheetName,
          row_kind: rowKind,
          url,
          wp_id: 0,
          wp_rest_path: wpRestPath,
          content_type_uid: contentTypeUid,
          migration_status: "NoWpId",
          migration_message: "WordPress ID missing and could not be inferred from URL",
          source_columns_json: sourceColumnsJson,
          extracted_at: extractedAt,
        })
      );
      continue;
    }
    rows.push(
      emptyTrackingRow({
        source_sheet: sheetName,
        row_kind: rowKind,
        url,
        wp_id: wpId,
        wp_rest_path: wpRestPath,
        content_type_uid: contentTypeUid,
        migration_status: "Pending",
        source_columns_json: sourceColumnsJson,
        extracted_at: extractedAt,
      })
    );
  }
  return { rows, missingIdUrls };
}

export async function runExtractUrls(argv: string[] = []): Promise<void> {
  const srcOverride = stringArg(argv, "--source-workbook");
  const trackOverride = stringArg(argv, "--tracking-workbook");
  const sheetOverride = stringArg(argv, "--tracking-sheet");
  const mediaTabOverride = stringArg(argv, "--media-tab");
  const restOverride = stringArg(argv, "--wp-rest-path");
  const sheetRestPathsOverride = stringArg(argv, "--sheet-wp-rest-paths");
  const sheetCtOverride = stringArg(argv, "--sheet-content-type-uid");
  const startSheetOverride = stringArg(argv, "--start-sheet");
  const ctOverride = stringArg(argv, "--content-type-uid");
  const runIdOverride = stringArg(argv, "--run-id");

  if (srcOverride) process.env.MIGRATION_SOURCE_WORKBOOK = srcOverride;
  if (trackOverride) process.env.MIGRATION_TRACKING_WORKBOOK = trackOverride;
  if (sheetOverride) process.env.MIGRATION_TRACKING_SHEET = sheetOverride;
  if (mediaTabOverride) process.env.MIGRATION_MEDIA_TAB_NAME = mediaTabOverride;
  if (restOverride) process.env.MIGRATION_WP_REST_PATH = restOverride;
  if (sheetRestPathsOverride) process.env.MIGRATION_SHEET_WP_REST_PATHS = sheetRestPathsOverride;
  if (sheetCtOverride) process.env.MIGRATION_SHEET_CONTENT_TYPE_UID = sheetCtOverride;
  if (startSheetOverride) process.env.MIGRATION_START_SHEET = startSheetOverride;
  if (ctOverride) process.env.MIGRATION_CONTENT_TYPE_UID = ctOverride;
  if (runIdOverride) process.env.MIGRATION_RUN_ID = runIdOverride;

  const paths = loadPipelinePaths();
  if (!existsSync(paths.sourceWorkbook)) {
    throw new Error(`MIGRATION_SOURCE_WORKBOOK not found: ${paths.sourceWorkbook}`);
  }
  const mongoCfg = loadMongoConfig();
  const coll = await getTrackingCollection(mongoCfg);

  const srcBuf = readFileSync(paths.sourceWorkbook);
  const wb = XLSX.read(srcBuf);
  const mediaTab = paths.mediaTabName;

  const incoming: TrackingRow[] = [];
  const allMissing: string[] = [];

  const sheetNames = wb.SheetNames.filter((n) => n.trim().length > 0);
  if (!sheetNames.includes(mediaTab)) {
    console.error(`Warning: media tab "${mediaTab}" not found in source workbook. Available: ${sheetNames.join(", ")}`);
  }

  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const matrix = sheetToMatrix(ws);
    const kind: TrackingRowKind = name === mediaTab ? "media" : "content";
    const restForRow = wpRestPathForSourceTab(paths, name, kind);
    const ct = contentTypeUidForSourceTab(paths, name, kind);
    const { rows, missingIdUrls } = parseSheetRows(name, matrix, kind, restForRow, ct);
    incoming.push(...rows);
    allMissing.push(...missingIdUrls);
  }

  for (const u of allMissing) {
    console.error(`[extract] Missing WordPress ID for URL: ${u}`);
  }

  const existing = readTrackingSheet(paths.trackingWorkbook, paths.trackingSheet);
  const merged = mergeTrackingRows(existing, incoming);
  writeTrackingSheet(paths.trackingWorkbook, paths.trackingSheet, merged);

  if (coll) {
    const now = new Date().toISOString();
    for (const r of merged) {
      await upsertTrackingDoc(coll, trackingRowToMongoDoc(paths, r, now));
    }
  }

  await closeMongo();
  console.error(
    `[extract] Wrote ${merged.length} rows to ${paths.trackingWorkbook} (sheet "${paths.trackingSheet}"). Missing-id URLs logged: ${allMissing.length}. MongoDB: ${mongoCfg.enabled ? "synced" : "skipped (set MONGODB_URI)"}.`
  );
}
