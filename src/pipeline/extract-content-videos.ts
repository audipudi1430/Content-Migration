import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { loadConfig } from "../config.js";
import {
  contentTypeUidForSourceTab,
  loadPipelinePaths,
  wpRestPathForSourceTab,
} from "../config-pipeline.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { numberArg, stringArg } from "./args.js";
import {
  collectStoryVideoRefs,
  dedupeContentVideoRefs,
  type ContentVideoRef,
} from "./collect-content-videos.js";
import {
  defaultContentVideosWorkbookPath,
  writeContentVideosWorkbook,
  type ContentVideoSheetRow,
} from "./content-videos-sheet.js";
import { fetchWpStoryForMigration, loadBlogFetchBySlug } from "./blog-story-fetch.js";
import { resolveWorkbookTabName } from "./extract-urls.js";
import { mapWithConcurrency } from "./async-pool.js";
import { emptyTrackingRow, type TrackingRow, type TrackingRowKind } from "./types.js";
import { enrichTrackingRowsFromWordPress, inferWpIdFromUrl } from "./wp-extract-enrich.js";

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

function sheetToMatrix(ws: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];
}

function parseSourceSheetRows(
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
    if (!Number.isFinite(wpId) || wpId <= 0) {
      rows.push(
        emptyTrackingRow({
          source_sheet: sheetName,
          row_kind: rowKind,
          wp_rest_path: wpRestPath,
          content_type_uid: contentTypeUid,
          url,
          wp_id: 0,
          migration_message: "No WordPress ID (re-run after fixing URL or add ID column)",
        })
      );
      continue;
    }
    rows.push(
      emptyTrackingRow({
        source_sheet: sheetName,
        row_kind: rowKind,
        wp_rest_path: wpRestPath,
        content_type_uid: contentTypeUid,
        url,
        wp_id: wpId,
      })
    );
  }
  return rows;
}

function extractConcurrency(argv: string[]): number {
  const fromArg = numberArg(argv, "--concurrency");
  const fromEnv = Number(process.env.MIGRATION_EXTRACT_CONCURRENCY ?? "6");
  const n = fromArg ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 6);
  return Math.max(1, Math.min(32, Math.floor(n)));
}

function toSheetRows(
  contentUrl: string,
  wordpressId: number,
  refs: ContentVideoRef[]
): ContentVideoSheetRow[] {
  return refs.map((ref) => ({
    url: contentUrl,
    wordpress_id: wordpressId,
    video_url: ref.videoUrl,
    video_type: ref.videoType,
    provider: ref.providerSlug,
  }));
}

export async function runExtractContentVideos(argv: string[] = []): Promise<void> {
  const srcOverride = stringArg(argv, "--source-workbook");
  const outputOverride = stringArg(argv, "--output-workbook");
  const tabOverride = stringArg(argv, "--tab");

  if (srcOverride) process.env.MIGRATION_SOURCE_WORKBOOK = srcOverride;
  if (tabOverride) process.env.MIGRATION_EXTRACT_TAB = tabOverride;

  const paths = loadPipelinePaths();
  const tabFilter =
    stringArg(argv, "--tab")?.trim() || process.env.MIGRATION_EXTRACT_TAB?.trim() || "";
  if (!tabFilter) {
    throw new Error(
      "extract-content-videos requires --tab=<Excel tab name> (e.g. stories)"
    );
  }

  if (!existsSync(paths.sourceWorkbook)) {
    throw new Error(`MIGRATION_SOURCE_WORKBOOK not found: ${paths.sourceWorkbook}`);
  }

  const srcBuf = readFileSync(paths.sourceWorkbook);
  const wb = XLSX.read(srcBuf);
  const sheetNames = wb.SheetNames.filter((n) => n.trim().length > 0);
  const tabName = resolveWorkbookTabName(sheetNames, tabFilter);
  const ws = wb.Sheets[tabName];
  if (!ws) throw new Error(`Sheet not found: ${tabName}`);

  const mediaTab = paths.mediaTabName;
  if (tabName === mediaTab) {
    throw new Error(`Tab "${tabName}" is the media tab. Use stories instead.`);
  }

  const rowKind: TrackingRowKind = "content";
  const restForRow = wpRestPathForSourceTab(paths, tabName, rowKind);
  const ct = contentTypeUidForSourceTab(paths, tabName, rowKind);
  const rows = parseSourceSheetRows(tabName, sheetToMatrix(ws), rowKind, restForRow, ct);
  console.error(`[extract-content-videos] Parsed tab "${tabName}": ${rows.length} URL row(s)`);

  if (process.env.MIGRATION_EXTRACT_SKIP_WP_ENRICH !== "1") {
    const cfg = loadConfig();
    const auth =
      cfg.wp.user && cfg.wp.applicationPassword
        ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
        : undefined;
    const wp = new WordPressClient(cfg.wp.baseUrl, auth);
    const concurrency = extractConcurrency(argv);
    console.error(
      `[extract-content-videos] Resolving WordPress IDs (${rows.length} rows, concurrency=${concurrency})…`
    );
    await enrichTrackingRowsFromWordPress(rows, wp, 80_000, concurrency);
  }

  const cfg = loadConfig();
  const auth =
    cfg.wp.user && cfg.wp.applicationPassword
      ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
      : undefined;
  const wp = new WordPressClient(cfg.wp.baseUrl, auth);
  const fetchStoryBySlug = loadBlogFetchBySlug();
  const concurrency = extractConcurrency(argv);
  const base = restForRow.replace(/^\//, "").replace(/\/$/, "");

  const sheetRowsByIndex: ContentVideoSheetRow[][] = new Array(rows.length);
  let processed = 0;
  let videoCount = 0;
  let storiesWithVideos = 0;

  await mapWithConcurrency(rows, concurrency, async (row, index) => {
    const contentUrl = row.url.trim() || row.wp_link.trim();
    if (row.wp_id <= 0) {
      console.error(
        `[extract-content-videos] Skipping row without wp_id: url=${contentUrl || "(empty)"}`
      );
      return;
    }

    try {
      const { story } = await fetchWpStoryForMigration(wp, base, row, row.wp_id, fetchStoryBySlug);
      const refs = dedupeContentVideoRefs(collectStoryVideoRefs(story));
      if (refs.length === 0) return;

      const outRows = toSheetRows(contentUrl || String(story.link ?? ""), row.wp_id, refs);
      sheetRowsByIndex[index] = outRows;
      videoCount += outRows.length;
      storiesWithVideos += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[extract-content-videos] wp_id=${row.wp_id} failed: ${msg}`);
    } finally {
      processed += 1;
      if (processed % 25 === 0 || processed === rows.length) {
        console.error(`[extract-content-videos] progress ${processed}/${rows.length}`);
      }
    }
  });

  const sheetRows = sheetRowsByIndex.flat().filter((r): r is ContentVideoSheetRow => Boolean(r));

  sheetRows.sort((a, b) => {
    if (a.wordpress_id !== b.wordpress_id) return a.wordpress_id - b.wordpress_id;
    const typeCmp = a.video_type.localeCompare(b.video_type);
    if (typeCmp !== 0) return typeCmp;
    return a.video_url.localeCompare(b.video_url);
  });

  const outputPath = outputOverride
    ? outputOverride
    : defaultContentVideosWorkbookPath(tabName);
  writeContentVideosWorkbook(outputPath, tabName, sheetRows);

  console.error(
    `[extract-content-videos] Wrote ${sheetRows.length} video row(s) for ${storiesWithVideos} stor` +
      `${storiesWithVideos === 1 ? "y" : "ies"} (${processed} content URL(s) scanned) ` +
      `to ${outputPath} (tab sheet "${tabName}").`
  );
}
