import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { loadConfig } from "../config.js";
import {
  contentTypeUidForSourceTab,
  loadPipelinePaths,
  wpRestPathForSourceTab,
} from "../config-pipeline.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import {
  fetchWordPressMediaById,
  findWordPressMediaByUrlWithClient,
  type WpMediaRestItem,
} from "../wordpress/find-media-by-url.js";
import { numberArg, stringArg } from "./args.js";
import { fetchWpStoryForMigration, loadBlogFetchBySlug } from "./blog-story-fetch.js";
import {
  collectAuthorImageRefs,
  collectCategoryImageRefs,
  collectStoryImageRefs,
  dedupeContentImageRefs,
  type ContentImageRef,
} from "./collect-content-images.js";
import {
  defaultContentImagesWorkbookPath,
  writeContentImagesWorkbook,
  type ContentImageSheetRow,
} from "./content-images-sheet.js";
import { resolveWorkbookTabName } from "./extract-urls.js";
import {
  exceedsImageSizeLimit,
  formatFileSizeBytes,
  loadMigrationImageMaxBytes,
} from "./image-size-limit.js";
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

function restSegment(restPath: string): string {
  return restPath.replace(/^\//, "").replace(/\/$/, "").split("/").pop()?.toLowerCase() ?? "";
}

function collectRefsForEntity(
  tabName: string,
  restPath: string,
  entity: Record<string, unknown>
): ContentImageRef[] {
  const seg = restSegment(restPath);
  if (seg === "stories" || seg === "story") {
    return dedupeContentImageRefs(collectStoryImageRefs(entity));
  }
  if (seg.includes("author")) {
    return dedupeContentImageRefs(collectAuthorImageRefs(entity));
  }
  if (seg.includes("categor")) {
    return dedupeContentImageRefs(collectCategoryImageRefs(entity));
  }

  const contentTypeUid = contentTypeUidForSourceTab(
    loadPipelinePaths(),
    tabName,
    "content"
  ).toLowerCase();
  if (contentTypeUid.includes("author")) {
    return dedupeContentImageRefs(collectAuthorImageRefs(entity));
  }
  if (contentTypeUid.includes("categor")) {
    return dedupeContentImageRefs(collectCategoryImageRefs(entity));
  }
  if (contentTypeUid.includes("blog") || contentTypeUid.includes("story")) {
    return dedupeContentImageRefs(collectStoryImageRefs(entity));
  }

  return dedupeContentImageRefs(collectStoryImageRefs(entity));
}

type ResolvedMedia = {
  mediaWordpressId: string;
  mediaUrl: string;
  sizeBytes: number | undefined;
};

async function probeUrlContentLength(url: string, authHeader?: string): Promise<number | undefined> {
  const t = url.trim();
  if (!t) return undefined;
  try {
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetch(t, { method: "HEAD", headers });
    if (!res.ok) return undefined;
    const raw = res.headers.get("content-length");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

function mediaFileSizeBytes(item: WpMediaRestItem | null | undefined): number | undefined {
  const n = item?.media_details?.filesize;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
  return undefined;
}

async function resolveMediaRef(
  ref: ContentImageRef,
  wp: WordPressClient,
  authHeader: string | undefined,
  mediaCache: Map<number, ResolvedMedia>,
  urlCache: Map<string, ResolvedMedia>
): Promise<ResolvedMedia> {
  if (ref.attachmentId && ref.attachmentId > 0) {
    const cached = mediaCache.get(ref.attachmentId);
    if (cached) return cached;
    const item = await fetchWordPressMediaById(wp, ref.attachmentId);
    let sizeBytes = mediaFileSizeBytes(item);
    const mediaUrl = item?.source_url?.trim() || ref.imageUrl?.trim() || "";
    if (!sizeBytes && mediaUrl) {
      sizeBytes = await probeUrlContentLength(mediaUrl, authHeader);
    }
    const resolved: ResolvedMedia = {
      mediaWordpressId: item?.id ? String(item.id) : String(ref.attachmentId),
      mediaUrl,
      sizeBytes,
    };
    mediaCache.set(ref.attachmentId, resolved);
    if (mediaUrl) urlCache.set(mediaUrl.toLowerCase(), resolved);
    return resolved;
  }

  const imageUrl = ref.imageUrl?.trim() ?? "";
  if (!imageUrl) {
    return { mediaWordpressId: "", mediaUrl: "", sizeBytes: undefined };
  }

  const cachedUrl = urlCache.get(imageUrl.toLowerCase());
  if (cachedUrl) return cachedUrl;

  const found = await findWordPressMediaByUrlWithClient(imageUrl, wp);
  if (found?.media) {
    let sizeBytes = mediaFileSizeBytes(found.media);
    const mediaUrl = found.media.source_url?.trim() || imageUrl;
    if (!sizeBytes) {
      sizeBytes = await probeUrlContentLength(mediaUrl, authHeader);
    }
    const resolved: ResolvedMedia = {
      mediaWordpressId: String(found.media.id),
      mediaUrl,
      sizeBytes,
    };
    if (found.media.id > 0) mediaCache.set(found.media.id, resolved);
    urlCache.set(imageUrl.toLowerCase(), resolved);
    return resolved;
  }

  const sizeBytes = await probeUrlContentLength(imageUrl, authHeader);
  const resolved: ResolvedMedia = {
    mediaWordpressId: "",
    mediaUrl: imageUrl,
    sizeBytes,
  };
  urlCache.set(imageUrl.toLowerCase(), resolved);
  return resolved;
}

function sizeOkLabel(sizeBytes: number | undefined, maxBytes: number): string {
  if (sizeBytes === undefined) return "";
  return exceedsImageSizeLimit(sizeBytes, maxBytes) ? "Not OK" : "OK";
}

async function fetchEntityForRow(
  row: TrackingRow,
  wp: WordPressClient,
  fetchStoryBySlug: boolean
): Promise<Record<string, unknown>> {
  const base = row.wp_rest_path.replace(/^\//, "").replace(/\/$/, "");
  const seg = restSegment(row.wp_rest_path);

  if ((seg === "stories" || seg === "story") && fetchStoryBySlug) {
    const { story } = await fetchWpStoryForMigration(wp, base, row, row.wp_id, true);
    return story;
  }

  if (seg.includes("author")) {
    return wp.getJson<Record<string, unknown>>(`${base}/${row.wp_id}`, { context: "edit" });
  }

  return wp.getJson<Record<string, unknown>>(`${base}/${row.wp_id}`);
}

function toSheetRows(
  contentUrl: string,
  wordpressId: number,
  refs: ContentImageRef[],
  resolved: ResolvedMedia[],
  maxBytes: number
): ContentImageSheetRow[] {
  const rows: ContentImageSheetRow[] = [];
  for (let i = 0; i < refs.length; i++) {
    const media = resolved[i]!;
    const sizeBytes = media.sizeBytes;
    rows.push({
      url: contentUrl,
      wordpress_id: wordpressId,
      media_wordpress_id: media.mediaWordpressId,
      media_url: media.mediaUrl,
      image_type: refs[i]!.imageType,
      Size: sizeBytes === undefined ? "" : formatFileSizeBytes(sizeBytes),
      "OK/Not OK": sizeOkLabel(sizeBytes, maxBytes),
    });
  }
  return rows;
}

export async function runExtractContentImages(argv: string[] = []): Promise<void> {
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
      "extract-content-images requires --tab=<Excel tab name> (e.g. stories, categories, blog_author)"
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
    throw new Error(
      `Tab "${tabName}" is the media tab. Use stories, categories, or blog_author instead.`
    );
  }

  const rowKind: TrackingRowKind = "content";
  const restForRow = wpRestPathForSourceTab(paths, tabName, rowKind);
  const ct = contentTypeUidForSourceTab(paths, tabName, rowKind);
  const rows = parseSourceSheetRows(tabName, sheetToMatrix(ws), rowKind, restForRow, ct);
  console.error(`[extract-content-images] Parsed tab "${tabName}": ${rows.length} URL row(s)`);

  if (process.env.MIGRATION_EXTRACT_SKIP_WP_ENRICH !== "1") {
    const cfg = loadConfig();
    const auth =
      cfg.wp.user && cfg.wp.applicationPassword
        ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
        : undefined;
    const wp = new WordPressClient(cfg.wp.baseUrl, auth);
    const concurrency = extractConcurrency(argv);
    console.error(
      `[extract-content-images] Resolving WordPress IDs (${rows.length} rows, concurrency=${concurrency})…`
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
  const maxBytes = loadMigrationImageMaxBytes();
  const concurrency = extractConcurrency(argv);
  const mediaCache = new Map<number, ResolvedMedia>();
  const urlCache = new Map<string, ResolvedMedia>();

  const sheetRowsByIndex: ContentImageSheetRow[][] = new Array(rows.length);
  let processed = 0;
  let imageCount = 0;
  let oversized = 0;

  await mapWithConcurrency(rows, concurrency, async (row, index) => {
    const contentUrl = row.url.trim() || row.wp_link.trim();
    if (row.wp_id <= 0) {
      console.error(
        `[extract-content-images] Skipping row without wp_id: url=${contentUrl || "(empty)"}`
      );
      return;
    }

    try {
      const entity = await fetchEntityForRow(row, wp, fetchStoryBySlug);
      const refs = collectRefsForEntity(tabName, restForRow, entity);
      const resolved: ResolvedMedia[] = [];
      for (const ref of refs) {
        resolved.push(await resolveMediaRef(ref, wp, auth, mediaCache, urlCache));
      }

      const outRows = toSheetRows(
        contentUrl || String(entity.link ?? ""),
        row.wp_id,
        refs,
        resolved,
        maxBytes
      );
      sheetRowsByIndex[index] = outRows;
      imageCount += outRows.length;
      oversized += outRows.filter((r) => r["OK/Not OK"] === "Not OK").length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[extract-content-images] wp_id=${row.wp_id} failed: ${msg}`);
    } finally {
      processed += 1;
      if (processed % 25 === 0 || processed === rows.length) {
        console.error(`[extract-content-images] progress ${processed}/${rows.length}`);
      }
    }
  });

  const sheetRows = sheetRowsByIndex.flat().filter((r): r is ContentImageSheetRow => Boolean(r));

  sheetRows.sort((a, b) => {
    if (a.wordpress_id !== b.wordpress_id) return a.wordpress_id - b.wordpress_id;
    const typeCmp = a.image_type.localeCompare(b.image_type);
    if (typeCmp !== 0) return typeCmp;
    const ma = Number(a.media_wordpress_id) || 0;
    const mb = Number(b.media_wordpress_id) || 0;
    if (ma !== mb) return ma - mb;
    return a.media_url.localeCompare(b.media_url);
  });

  const outputPath = outputOverride
    ? outputOverride
    : defaultContentImagesWorkbookPath(tabName);
  writeContentImagesWorkbook(outputPath, tabName, sheetRows);

  console.error(
    `[extract-content-images] Wrote ${sheetRows.length} image row(s) for ${processed} content URL(s) ` +
      `to ${outputPath} (tab sheet "${tabName}"). ` +
      `Not OK (>${formatFileSizeBytes(maxBytes)}): ${oversized}.`
  );
}
