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
import type { TrackingRow } from "./types.js";
import {
  bConnectedStatusWorkbookPath,
  defaultBConnectedWorkbookPath,
  isBConnectedPending,
  mergeBConnectedPriorTracking,
  readBConnectedWorkbook,
  resolveBConnectedTabName,
  writeBConnectedStatusWorkbook,
} from "./update-bconnected-stories-sheet.js";
import { buildEntryUrlUpdatePayload } from "./update-entry-urls.js";
import {
  loadMigrationPageOwnerValue,
  loadSharedSeoInnerFieldUids,
  loadSharedSeoPageUrlFields,
  resolveSeoPageUrlShape,
  type SeoSocialFieldUids,
} from "./seo-social-payload.js";

const DEFAULT_LIMIT = 20;
/** Keep modest: each row does multiple CMA calls; high concurrency → Contentstack 429. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

function loadConcurrency(argv: string[]): number {
  const raw =
    stringArg(argv, "--concurrency") ?? process.env.BCONNECTED_CONCURRENCY ?? String(DEFAULT_CONCURRENCY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), MAX_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
}

function loadLimit(argv: string[]): number {
  if (argv.includes("--all")) return Number.MAX_SAFE_INTEGER;
  const fromArg = numberArg(argv, "--limit");
  if (fromArg != null) {
    // --limit=0 means all pending
    if (fromArg <= 0) return Number.MAX_SAFE_INTEGER;
    return fromArg;
  }
  const fromEnv = process.env.BCONNECTED_LIMIT?.trim();
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n <= 0) return Number.MAX_SAFE_INTEGER;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_LIMIT;
}

function urlLookupCandidates(raw: string): string[] {
  const path = normalizeMigrationUrlPath(raw);
  if (!path) return [];
  const out = new Set<string>([path]);
  if (path !== "/" && path.endsWith("/")) out.add(path.replace(/\/+$/, ""));
  else if (path !== "/") out.add(`${path}/`);
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
  return {
    ...blog,
    seoPageUrlShape: resolveSeoPageUrlShape(
      process.env.UPDATE_ENTRY_URL_SEO_PAGE_URL_SHAPE ?? process.env.BLOG_SEO_PAGE_URL_SHAPE,
      "canonical_url_list"
    ),
    ...loadSharedSeoPageUrlFields(),
    ...loadSharedSeoInnerFieldUids(),
  };
}

/** Default page owner when `seo.page_owner` is empty (env PAGE_OWNER, else Broadcom). */
function resolvePageOwnerDefault(): string {
  return loadMigrationPageOwnerValue() || "Broadcom";
}

function pathSet(...raws: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of raws) {
    for (const c of urlLookupCandidates(raw)) out.add(c.toLowerCase());
  }
  return out;
}

/** Prefer migrate/extract tracking UID matched on sheet url (old path). */
function uidFromMigrationTracking(
  allTracking: TrackingRow[],
  url: string,
  newUrl: string
): { uid: string; matchedOn: "url" | "new_url" } | undefined {
  const urlPaths = pathSet(url);
  const newPaths = pathSet(newUrl);
  for (const t of allTracking) {
    const uid = t.contentstack_entry_uid?.trim();
    if (!uid) continue;
    const trackPaths = pathSet(t.url, t.new_url, t.target_url);
    let matchedUrl = false;
    let matchedNew = false;
    for (const p of trackPaths) {
      if (urlPaths.has(p)) matchedUrl = true;
      if (newPaths.has(p)) matchedNew = true;
    }
    if (matchedUrl) return { uid, matchedOn: "url" };
    if (matchedNew) return { uid, matchedOn: "new_url" };
  }
  return undefined;
}

async function findEntryUidByUrlCandidates(
  cs: ContentstackManagementClient,
  contentTypeUid: string,
  candidates: string[],
  locale: string,
  urlField: string
): Promise<string[]> {
  if (candidates.length === 0) return [];
  return cs.findEntryUidsByExactUrl(contentTypeUid, candidates, locale, urlField);
}

/**
 * Update already-migrated blog entries from an input workbook:
 * - find by sheet `url`; if missing, find by `new_url` → status "Already Updated" (no write)
 * - otherwise update url (3 places), append categories/topics
 * - default batch 20 pending rows, concurrency 20; merge prior tracking each run
 */
export async function runUpdateBConnectedStories(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const workbookPath = defaultBConnectedWorkbookPath(
    stringArg(argv, "--workbook") ?? stringArg(argv, "--sheet-file")
  );
  const tabName = resolveBConnectedTabName(stringArg(argv, "--tab"));
  const skipDone = !argv.includes("--no-skip-pass");
  const concurrency = loadConcurrency(argv);
  const offset = Math.max(0, numberArg(argv, "--offset") ?? 0);
  const limit = loadLimit(argv);
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
  const mergedPrior = mergeBConnectedPriorTracking(workbookPath, allRows);
  const allTracking = loadAllTracking(paths);

  // Seed UIDs from extract/migrate tracking (helps tracking sheet + retries).
  let seededFromMigrate = 0;
  for (const row of allRows) {
    if (row.contentstack_entry_uid.trim()) continue;
    const hit = uidFromMigrationTracking(allTracking, row.url, row.new_url);
    if (!hit) continue;
    row.contentstack_entry_uid = hit.uid;
    seededFromMigrate += 1;
  }

  const pendingIndexes = allRows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => (skipDone ? isBConnectedPending(row) : true))
    .map(({ i }) => i);

  const end = Math.min(pendingIndexes.length, offset + limit);
  const workIndexes = pendingIndexes.slice(offset, end);

  console.error(
    `[b-connected] workbook=${workbookPath} tab=${tabName} ` +
      `pending=${pendingIndexes.length}/${allRows.length} work=${workIndexes.length} ` +
      `offset=${offset} limit=${limit === Number.MAX_SAFE_INTEGER ? "all" : limit} ` +
      `concurrency=${concurrency} mergedTracking=${mergedPrior} migrateUids=${seededFromMigrate} ` +
      `contentType=${contentTypeUid} locale=${locale}`
  );

  if (workIndexes.length === 0) {
    console.error("[b-connected] No pending rows to process.");
    writeBConnectedStatusWorkbook(workbookPath, allRows);
    return;
  }

  let updated = 0;
  let alreadyUpdated = 0;
  let skipped = 0;
  let failed = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(() => {
      writeBConnectedStatusWorkbook(workbookPath, allRows);
    });
    return writeChain;
  };

  await mapWithConcurrency(workIndexes, concurrency, async (rowIndex) => {
    const row = allRows[rowIndex]!;
    const now = new Date().toISOString();

    if (skipDone && !isBConnectedPending(row)) {
      skipped += 1;
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

    let entryUid = "";
    try {
      const urlCandidates = urlLookupCandidates(row.url);
      const newUrlCandidates = urlLookupCandidates(row.new_url);

      const byUrl = await findEntryUidByUrlCandidates(
        cs,
        contentTypeUid,
        urlCandidates,
        locale,
        fields.url
      );

      if (byUrl.length > 0) {
        entryUid = byUrl[0]!;
        if (byUrl.length > 1) {
          console.error(
            `[b-connected] WARNING: ${byUrl.length} entries matched url; using ${entryUid}`
          );
        }
      } else {
        const byNew = await findEntryUidByUrlCandidates(
          cs,
          contentTypeUid,
          newUrlCandidates,
          locale,
          fields.url
        );
        if (byNew.length > 0) {
          entryUid = byNew[0]!;
          row.contentstack_entry_uid = entryUid;
          row.update_status = "Already Updated";
          row.update_message = `Entry already at new_url (found by new_url); no changes applied`;
          row.updated_at = now;
          alreadyUpdated += 1;
          allRows[rowIndex] = row;
          await persist();
          console.error(
            `[b-connected] Already Updated uid=${entryUid} new_url=${newPath}`
          );
          return;
        }

        // Fallback: extract/migrate tracking UID matched on old url only.
        const migrateHit = uidFromMigrationTracking(allTracking, row.url, row.new_url);
        if (migrateHit?.matchedOn === "url") {
          entryUid = migrateHit.uid;
          console.error(
            `[b-connected] uid=${entryUid} from migrate tracking (url match); CS url lookup empty`
          );
        } else if (migrateHit?.matchedOn === "new_url") {
          entryUid = migrateHit.uid;
          row.contentstack_entry_uid = entryUid;
          row.update_status = "Already Updated";
          row.update_message =
            "Entry already at new_url (migrate tracking matched new_url); no changes applied";
          row.updated_at = now;
          alreadyUpdated += 1;
          allRows[rowIndex] = row;
          await persist();
          console.error(
            `[b-connected] Already Updated uid=${entryUid} (migrate tracking new_url)`
          );
          return;
        } else {
          throw new Error(
            `No Contentstack entry for url=${urlCandidates.join("|") || "(empty)"} ` +
              `or new_url=${newUrlCandidates.join("|") || "(empty)"}`
          );
        }
      }

      row.contentstack_entry_uid = entryUid;

      const existing = await cs.getEntry(contentTypeUid, entryUid, locale);
      const currentPath = normalizeMigrationUrlPath(String(existing[fields.url] ?? ""));
      const newPathSet = pathSet(row.new_url, newPath);
      const oldPathSet = pathSet(row.url);
      if (
        currentPath &&
        newPathSet.has(currentPath.toLowerCase()) &&
        !oldPathSet.has(currentPath.toLowerCase())
      ) {
        row.update_status = "Already Updated";
        row.update_message = `Entry url already ${currentPath}; no changes applied`;
        row.updated_at = now;
        alreadyUpdated += 1;
        allRows[rowIndex] = row;
        await persist();
        console.error(
          `[b-connected] Already Updated uid=${entryUid} current=${currentPath}`
        );
        return;
      }

      const urlPatch = buildEntryUrlUpdatePayload({
        existing,
        updatedPath: newPath,
        urlField: fields.url,
        seoGroup: fields.seoSocialGroup,
        pageUrlField: fields.seoPageUrl,
        canonicalField: fields.seoPageUrlCanonicalField,
        seoFields,
      });

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

      const pageOwnerField = seoFields.seoPageOwner || "page_owner";
      const existingPageOwner = String(seo[pageOwnerField] ?? "").trim();
      let pageOwnerSet = false;
      if (!existingPageOwner) {
        seo[pageOwnerField] = resolvePageOwnerDefault();
        pageOwnerSet = true;
        console.error(
          `[b-connected] uid=${entryUid} seo.${pageOwnerField} ← ${seo[pageOwnerField]}`
        );
      }

      const payload: Record<string, unknown> & { title: string } = {
        title: urlPatch.title,
        [fields.url]: urlPatch.url,
        [fields.seoSocialGroup]: seo,
      };

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
        setEntryReferences(payload, fields.blogCategory, merged, categoryCt);
        console.error(
          `[b-connected] uid=${entryUid} blog_category keep=${existingCatUids.length} ` +
            `add=${resolved.length} total=${merged.length} labels=${labels.join(", ") || "(none)"}`
        );
      }

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
        pageOwnerSet ? `page_owner←${seo[pageOwnerField]}` : "",
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
    `[b-connected] Done. updated=${updated} alreadyUpdated=${alreadyUpdated} ` +
      `skipped=${skipped} failed=${failed} tracking=${bConnectedStatusWorkbookPath(workbookPath)}`
  );
}
