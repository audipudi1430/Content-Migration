import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  contentTypeUidForSourceTab,
  loadMongoConfig,
  loadPipelinePaths,
  wpRestPathForSourceTab,
} from "../config-pipeline.js";
import { upsertTrackingDoc, getTrackingCollection, closeMongo } from "../mongo/tracking-repository.js";
import { loadConfig } from "../config.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import {
  mergeTrackingRows,
  mergeTrackingRowsReplacingSourceTab,
  readAllTrackingRowsFromWorkbook,
  writeTrackingWorkbook,
} from "./tracking-io.js";
import { emptyTrackingRow, type TrackingRow, type TrackingRowKind } from "./types.js";
import { numberArg, stringArg } from "./args.js";
import { trackingRowToMongoDoc } from "./tracking-sync.js";
import { inferWpIdFromUrl, enrichTrackingRowsFromWordPress } from "./wp-extract-enrich.js";

function normHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
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
): TrackingRow[] {
  if (matrix.length === 0) return [];
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
  return rows;
}

/** Match workbook tab name (exact, then case-insensitive). */
export function resolveWorkbookTabName(sheetNames: string[], requested: string): string {
  const t = requested.trim();
  if (!t) throw new Error("Tab name is empty");
  if (sheetNames.includes(t)) return t;
  const lower = t.toLowerCase();
  const hit = sheetNames.find((n) => n.toLowerCase() === lower);
  if (hit) return hit;
  throw new Error(`Tab "${requested}" not found in source workbook. Available: ${sheetNames.join(", ")}`);
}

function extractConcurrency(argv: string[]): number {
  const fromArg = numberArg(argv, "--concurrency");
  const fromEnv = Number(process.env.MIGRATION_EXTRACT_CONCURRENCY ?? "6");
  const n = fromArg ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 6);
  return Math.max(1, Math.min(32, Math.floor(n)));
}

function perTabTrackingSheetsEnabled(argv: string[]): boolean {
  const arg = stringArg(argv, "--per-tab-tracking");
  if (arg === "0" || arg === "false") return false;
  if (arg === "1" || arg === "true") return true;
  return process.env.MIGRATION_TRACKING_PER_TAB_SHEETS !== "0";
}

async function enrichIncoming(
  incoming: TrackingRow[],
  argv: string[],
  tabLabel: string
): Promise<void> {
  if (process.env.MIGRATION_EXTRACT_SKIP_WP_ENRICH === "1") return;
  const concurrency = extractConcurrency(argv);
  try {
    const cfg = loadConfig();
    const auth =
      cfg.wp.user && cfg.wp.applicationPassword
        ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
        : undefined;
    const wp = new WordPressClient(cfg.wp.baseUrl, auth);
    const maxJson = Number(process.env.MIGRATION_WP_EXTRACT_JSON_MAX_BYTES ?? "80000") || 80_000;
    let lastLogged = 0;
    console.error(
      `[extract] ${tabLabel}: WordPress REST enrich (${incoming.length} rows, concurrency=${concurrency})…`
    );
    await enrichTrackingRowsFromWordPress(incoming, wp, maxJson, concurrency, (done, total) => {
      if (done - lastLogged >= 25 || done === total) {
        lastLogged = done;
        console.error(`[extract] ${tabLabel}: enrich progress ${done}/${total}`);
      }
    });
    const noId = incoming.filter((r) => r.wp_id <= 0 && r.url.trim()).length;
    console.error(
      `[extract] ${tabLabel}: enrich done — ${incoming.length - noId}/${incoming.length} rows have wp_id.`
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error(
      `[extract] ${tabLabel}: WordPress enrich skipped (WP_BASE_URL + token, or MIGRATION_EXTRACT_SKIP_WP_ENRICH=1): ${m}`
    );
  }
}

function logStillMissing(incoming: TrackingRow[], tabLabel: string): TrackingRow[] {
  const stillMissing = incoming.filter((r) => r.wp_id <= 0 && r.url.trim());
  for (const r of stillMissing) {
    console.error(
      `[extract] Still no WordPress ID (${tabLabel}): sheet=${r.source_sheet} url=${r.url} rest=${r.wp_rest_path} msg=${r.migration_message || "-"}`
    );
  }
  return stillMissing;
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
  const tabOverride = stringArg(argv, "--tab");

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
  if (tabOverride) process.env.MIGRATION_EXTRACT_TAB = tabOverride;

  const paths = loadPipelinePaths();
  if (!existsSync(paths.sourceWorkbook)) {
    throw new Error(`MIGRATION_SOURCE_WORKBOOK not found: ${paths.sourceWorkbook}`);
  }
  const mongoCfg = loadMongoConfig();
  const coll = await getTrackingCollection(mongoCfg);
  const tabFilterEarly =
    stringArg(argv, "--tab")?.trim() || process.env.MIGRATION_EXTRACT_TAB?.trim() || "";
  const perTabSheets = tabFilterEarly ? true : perTabTrackingSheetsEnabled(argv);

  const srcBuf = readFileSync(paths.sourceWorkbook);
  const wb = XLSX.read(srcBuf);
  const mediaTab = paths.mediaTabName;
  const sheetNames = wb.SheetNames.filter((n) => n.trim().length > 0);

  const tabFilter = tabFilterEarly;

  const tabsToProcess: string[] = tabFilter
    ? [resolveWorkbookTabName(sheetNames, tabFilter)]
    : sheetNames;

  if (!tabFilter && !sheetNames.includes(mediaTab)) {
    console.error(`Warning: media tab "${mediaTab}" not found in source workbook. Available: ${sheetNames.join(", ")}`);
  }

  const incoming: TrackingRow[] = [];

  for (const name of tabsToProcess) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const matrix = sheetToMatrix(ws);
    const kind: TrackingRowKind = name === mediaTab ? "media" : "content";
    const restForRow = wpRestPathForSourceTab(paths, name, kind);
    const ct = contentTypeUidForSourceTab(paths, name, kind);
    const rows = parseSheetRows(name, matrix, kind, restForRow, ct);
    incoming.push(...rows);
    console.error(`[extract] Parsed tab "${name}": ${rows.length} rows (${kind}, rest=${restForRow})`);
  }

  const tabLabel = tabFilter ? `tab=${tabsToProcess[0]}` : `all tabs (${tabsToProcess.length})`;
  await enrichIncoming(incoming, argv, tabLabel);
  const stillMissing = logStillMissing(incoming, tabLabel);

  const existing = readAllTrackingRowsFromWorkbook(paths.trackingWorkbook);
  const merged = tabFilter
    ? mergeTrackingRowsReplacingSourceTab(existing, incoming, tabsToProcess[0]!)
    : mergeTrackingRows(existing, incoming);

  writeTrackingWorkbook(paths.trackingWorkbook, paths.trackingSheet, merged, perTabSheets);

  if (coll) {
    const now = new Date().toISOString();
    const mongoRows = tabFilter
      ? merged.filter((r) => r.source_sheet === tabsToProcess[0])
      : merged;
    for (const r of mongoRows) {
      await upsertTrackingDoc(coll, trackingRowToMongoDoc(paths, r, now));
    }
    console.error(`[extract] MongoDB: upserted ${mongoRows.length} document(s).`);
  }

  await closeMongo();
  const tabRows = tabFilter ? merged.filter((r) => r.source_sheet === tabsToProcess[0]) : merged;
  console.error(
    `[extract] Wrote ${merged.length} total rows to ${paths.trackingWorkbook} (consolidated sheet "${paths.trackingSheet}"${perTabSheets ? ", plus one sheet per source tab" : ""}). ` +
      `${tabLabel}: ${tabRows.length} rows in this run; still without wp_id: ${stillMissing.length}. ` +
      `MongoDB: ${mongoCfg.enabled ? "synced" : "skipped (set MONGODB_URI)"}.`
  );
}
