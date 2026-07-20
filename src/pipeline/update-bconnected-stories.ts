import { loadConfig } from "../config.js";
import { loadPipelinePaths } from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { initPipelineEnv, numberArg, stringArg } from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import {
  loadBlogCategoryRefContentTypeUid,
  loadBlogContentTypeUid,
  loadBlogFieldUids,
} from "./blog-config.js";
import {
  setEntryReferences,
  setThumbnailField,
  pickExistingThumbnailFocalPoint,
} from "./blog-payload.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import {
  parseCommaSeparatedLabels,
  storySheetCategoryLabels,
  storySheetHasCategoryColumns,
} from "./blog-story-sheet.js";
import { normalizeMigrationUrlPath } from "./migration-url.js";
import { resolveBlogCategoryUidsByNames } from "./resolve-entry-ref-by-name.js";
import { loadAllTracking } from "./tracking-sync.js";
import {
  bConnectedStatusWorkbookPath,
  defaultBConnectedWorkbookPath,
  readBConnectedWorkbook,
  resolveBConnectedTabName,
  writeBConnectedStatusWorkbook,
  type BConnectedUpdateRow,
} from "./update-bconnected-stories-sheet.js";
import { buildEntryUrlUpdatePayload } from "./update-entry-urls.js";
import {
  loadSharedSeoPageUrlFields,
  resolveSeoPageUrlShape,
  type SeoSocialFieldUids,
} from "./seo-social-payload.js";

function loadConcurrency(argv: string[]): number {
  const raw = stringArg(argv, "--concurrency") ?? process.env.BCONNECTED_CONCURRENCY ?? "4";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 4;
}

function urlLookupCandidates(raw: string): string[] {
  const path = normalizeMigrationUrlPath(raw);
  if (!path) return [];
  const out = new Set<string>([path]);
  if (path !== "/" && path.endsWith("/")) out.add(path.replace(/\/+$/, ""));
  else if (path !== "/") out.add(`${path}/`);
  // Also try original trimmed value if it differs (full URLs already normalized to path).
  const trimmed = raw.trim();
  if (trimmed && trimmed !== path) out.add(trimmed);
  return [...out];
}

function extractAssetUid(fileValue: unknown): string {
  if (typeof fileValue === "string") return fileValue.trim();
  if (Array.isArray(fileValue) && fileValue.length > 0) {
    return extractAssetUid(fileValue[0]);
  }
  if (fileValue && typeof fileValue === "object") {
    const uid = (fileValue as { uid?: unknown }).uid;
    if (typeof uid === "string") return uid.trim();
  }
  return "";
}

/** Read asset UID from entry `banner_image` (group/file or direct). */
function pickBannerAssetUid(
  entry: Record<string, unknown>,
  bannerField: string,
  fileField: string
): string {
  const banner = entry[bannerField];
  if (!banner) return "";
  if (typeof banner === "string") return banner.trim();
  if (typeof banner === "object" && !Array.isArray(banner)) {
    const group = banner as Record<string, unknown>;
    return (
      extractAssetUid(group[fileField]) ||
      extractAssetUid(group.file) ||
      extractAssetUid(group.image) ||
      extractAssetUid(group.uid ? group : undefined)
    );
  }
  if (Array.isArray(banner) && banner[0]) {
    return extractAssetUid(banner[0]);
  }
  return "";
}

function existingCategoryUids(
  entry: Record<string, unknown>,
  fieldUid: string
): string[] {
  const raw = entry[fieldUid];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const uid = String((item as { uid?: unknown }).uid ?? "").trim();
    if (uid) out.push(uid);
  }
  return out;
}

function existingTopicLabels(entry: Record<string, unknown>, fieldUid: string): string[] {
  const raw = entry[fieldUid];
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v ?? "").trim()).filter(Boolean);
}

function mergeUnique(existing: string[], next: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...existing, ...next]) {
    const key = v.trim();
    if (!key) continue;
    const lk = key.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    out.push(key);
  }
  return out;
}

function loadSeoFieldsForUrlPatch(): SeoSocialFieldUids {
  const blog = loadBlogFieldUids();
  const shared = loadSharedSeoPageUrlFields();
  return {
    ...blog,
    seoPageUrlShape: resolveSeoPageUrlShape(
      process.env.UPDATE_ENTRY_URL_SEO_PAGE_URL_SHAPE ?? process.env.BLOG_SEO_PAGE_URL_SHAPE,
      "canonical_url_list"
    ),
    ...shared,
  };
}

/**
 * Update already-migrated blog entries from an input workbook:
 * - find Contentstack entry by sheet `url`
 * - update url in three places from `new_url` (top-level url, seo canonical, url_list)
 * - append L1/L2/Series → blog_category (keep existing refs)
 * - append L3 → blog_topics (keep existing topics)
 * - optionally copy banner_image → article_image when present
 * - write `*-tracking.xlsx` with url, new_url, contentstack_entry_uid, Pass/Fail
 */
export async function runUpdateBConnectedStories(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const workbookPath = defaultBConnectedWorkbookPath(
    stringArg(argv, "--workbook") ?? stringArg(argv, "--sheet-file")
  );
  const tabName = resolveBConnectedTabName(stringArg(argv, "--tab"));
  const skipPass = !argv.includes("--no-skip-pass");
  const concurrency = loadConcurrency(argv);
  const offset = Math.max(0, numberArg(argv, "--offset") ?? 0);
  const limit = numberArg(argv, "--limit");
  const locale =
    stringArg(argv, "--locale")?.trim() ||
    process.env.BCONNECTED_LOCALE?.trim() ||
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    "en-us";
  const contentTypeUid =
    stringArg(argv, "--content-type")?.trim() ||
    process.env.BCONNECTED_CONTENT_TYPE?.trim() ||
    loadBlogContentTypeUid() ||
    "blog";

  const fields = loadBlogFieldUids();
  const categoryCt = loadBlogCategoryRefContentTypeUid();
  const seoFields = loadSeoFieldsForUrlPatch();
  const paths = loadPipelinePaths();
  const cfg = loadConfig();
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });

  const allRows = readBConnectedWorkbook(workbookPath, tabName);
  const end =
    limit != null && limit > 0 ? Math.min(allRows.length, offset + limit) : allRows.length;
  const workIndexes: number[] = [];
  for (let i = offset; i < end; i++) workIndexes.push(i);

  const allTracking = loadAllTracking(paths);

  console.error(
    `[b-connected] workbook=${workbookPath} tab=${tabName} ` +
      `rows=${workIndexes.length}/${allRows.length} offset=${offset}` +
      (limit != null && limit > 0 ? ` limit=${limit}` : " limit=all") +
      ` contentType=${contentTypeUid} locale=${locale} concurrency=${concurrency}`
  );

  if (workIndexes.length === 0) {
    console.error("[b-connected] No rows to process.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(() => {
      // Full sheet so offset/limit batches accumulate in one tracking workbook.
      writeBConnectedStatusWorkbook(workbookPath, allRows);
    });
    return writeChain;
  };

  await mapWithConcurrency(workIndexes, concurrency, async (rowIndex) => {
    const row = allRows[rowIndex]!;
    const now = new Date().toISOString();

    if (skipPass && row.update_status === "Pass") {
      skipped += 1;
      console.error(`[b-connected] skip (already Pass): url=${row.url || row.new_url}`);
      return;
    }

    const newPath = normalizeMigrationUrlPath(row.new_url);
    if (!newPath) {
      row.update_status = "Fail";
      row.update_message = "Missing new_url";
      row.updated_at = now;
      failed += 1;
      allRows[rowIndex] = row;
      await persist();
      return;
    }

    let entryUid = row.contentstack_entry_uid.trim();
    try {
      if (!entryUid) {
        const candidates = urlLookupCandidates(row.url);
        if (candidates.length === 0) {
          throw new Error("Missing url for Contentstack lookup");
        }
        const matches = await cs.findEntryUidsByExactUrl(
          contentTypeUid,
          candidates,
          locale,
          fields.url
        );
        if (matches.length === 0) {
          throw new Error(
            `No Contentstack entry found for url candidates: ${candidates.join(", ")}`
          );
        }
        entryUid = matches[0]!;
        row.contentstack_entry_uid = entryUid;
        if (matches.length > 1) {
          console.error(
            `[b-connected] WARNING: ${matches.length} entries matched url; using ${entryUid}`
          );
        }
      }

      const existing = await cs.getEntry(contentTypeUid, entryUid, locale);
      const urlPatch = buildEntryUrlUpdatePayload({
        existing,
        updatedPath: newPath,
        urlField: fields.url,
        seoGroup: fields.seoSocialGroup,
        pageUrlField: fields.seoPageUrl,
        canonicalField: fields.seoPageUrlCanonicalField,
        seoFields,
      });

      // Sanitize meta_image for write (same as update-entry-urls).
      const seo = urlPatch.seo;
      const metaImage = seo[fields.metaImageGroup];
      if (metaImage && typeof metaImage === "object" && !Array.isArray(metaImage)) {
        const group = { ...(metaImage as Record<string, unknown>) };
        const fileUid = extractAssetUid(group[fields.metaImageFileField] ?? group.file);
        if (fileUid) {
          group[fields.metaImageFileField] = contentstackFileRefValue(
            fileUid,
            fields.fileRefShape
          );
          seo[fields.metaImageGroup] = group;
        }
      }

      const payload: Record<string, unknown> & { title: string } = {
        title: urlPatch.title,
        [fields.url]: urlPatch.url,
        [fields.seoSocialGroup]: seo,
      };

      // banner_image (sheet override or entry) → article_image
      const bannerUid =
        row.banner_image.trim() ||
        pickBannerAssetUid(existing, fields.bannerImage, fields.bannerImageFileField);
      if (bannerUid) {
        const existingThumb =
          existing[fields.thumbnail] &&
          typeof existing[fields.thumbnail] === "object" &&
          !Array.isArray(existing[fields.thumbnail])
            ? (existing[fields.thumbnail] as Record<string, unknown>)
            : undefined;
        const focal = pickExistingThumbnailFocalPoint(existingThumb, fields);
        setThumbnailField(payload, fields, bannerUid, existingThumb, {
          focalPoint: focal,
        });
        console.error(
          `[b-connected] uid=${entryUid} article_image ← banner asset ${bannerUid}`
        );
      } else {
        console.error(
          `[b-connected] uid=${entryUid} WARNING: no banner_image asset to copy to article_image`
        );
      }

      // L1 / L2 / Series → append to blog_category (never replace existing)
      const existingCatUids = existingCategoryUids(existing, fields.blogCategory);
      if (storySheetHasCategoryColumns(row.sheetCols)) {
        const labels = storySheetCategoryLabels(row.sheetCols);
        const resolved = labels.length
          ? await resolveBlogCategoryUidsByNames({
              names: labels,
              cs,
              categoryContentTypeUid: categoryCt,
              allTracking,
              locale,
            })
          : [];
        const merged = mergeUnique(existingCatUids, resolved);
        // Always send merged list so Contentstack keeps prior refs + new ones.
        setEntryReferences(payload, fields.blogCategory, merged, categoryCt);
        console.error(
          `[b-connected] uid=${entryUid} blog_category keep=${existingCatUids.length} ` +
            `add=${resolved.length} total=${merged.length} labels=${labels.join(", ") || "(none)"}`
        );
      }

      // L3 → append to blog_topics (never remove existing)
      const existingTopics = existingTopicLabels(existing, fields.blogTopics);
      if (row.sheetCols.l3ColumnPresent) {
        const added = parseCommaSeparatedLabels(row.sheetCols.l3);
        const topics = mergeUnique(existingTopics, added);
        payload[fields.blogTopics] = topics;
        console.error(
          `[b-connected] uid=${entryUid} blog_topics keep=${existingTopics.length} ` +
            `add=${added.length} total=${topics.length}`
        );
      }

      await cs.updateEntry(contentTypeUid, entryUid, payload, locale);

      row.contentstack_entry_uid = entryUid;
      row.previous_url = urlPatch.previousUrl;
      row.url = row.url || urlPatch.previousUrl;
      row.new_url = newPath;
      row.update_status = "Pass";
      row.update_message = [
        `url→${newPath} (url + canonical + url_list)`,
        bannerUid ? `article_image←${bannerUid}` : "article_image skipped",
        storySheetHasCategoryColumns(row.sheetCols) ? "categories appended" : "",
        row.sheetCols.l3ColumnPresent ? "topics appended" : "",
      ]
        .filter(Boolean)
        .join("; ");
      row.updated_at = now;
      updated += 1;

      console.error(
        `[b-connected] Pass uid=${entryUid} ${urlPatch.previousUrl || "(none)"} → ${newPath}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      if (entryUid) row.contentstack_entry_uid = entryUid;
      row.update_status = "Fail";
      row.update_message = msg;
      row.updated_at = now;
      failed += 1;
      console.error(
        `[b-connected] FAIL url=${row.url || "(none)"}: ${msg.slice(0, 220)}`
      );
    } finally {
      allRows[rowIndex] = row;
      await persist();
    }
  });

  await persist();
  console.error(
    `[b-connected] Done. updated=${updated} skipped=${skipped} failed=${failed} ` +
      `tracking=${bConnectedStatusWorkbookPath(workbookPath)}`
  );
}
