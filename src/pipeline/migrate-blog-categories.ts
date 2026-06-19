import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ensureAssetFolderUid } from "../media/migrate-media-core.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, parseUpdateFlag, type SelectionMode } from "./args.js";
import {
  blogCategoryPageUrlPath,
  loadBlogCategoryContentTypeUid,
  loadBlogCategoryFieldUids,
  type BlogCategoryFieldUids,
} from "./blog-category-config.js";
import {
  extractWpCategorySeo,
  pickYoastOgImageUrl,
  type WpStoryCategory,
} from "./blog-category-seo.js";
import {
  setCategorySeoGlobal,
  setCategorySubCategoryRefs,
  setCategoryThumbnailField,
} from "./blog-category-payload.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import { selectCategoryContentRows } from "./migrate-from-tracking.js";
import { buildContentstackEntryTargetUrl } from "./cs-target-url.js";
import { upsertContentstackEntryWithSeoFallback } from "./contentstack-entry-upsert.js";
import { MigrationWarnings, mergeMigrationMessages } from "./image-size-limit.js";
import { tryResolveWpImageAssetFromUrl } from "./resolve-wp-image-from-url.js";
import { resolveMigrationPageUrlForRow, withMigrationPageUrl } from "./migration-url.js";
import {
  buildSheetOnlyCategoryTerm,
  isSheetOnlyCategoryRow,
  parseCategorySheetColumns,
  trackingRowHasSourceUrl,
} from "./blog-category-sheet.js";
import type { PipelinePathsConfig } from "../config-pipeline.js";
import type { TrackingRow } from "./types.js";

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function setScalar(entry: Record<string, unknown>, fieldUid: string, value: unknown): void {
  if (!fieldUid) return;
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  entry[fieldUid] = value;
}

type BuildCategoryPayloadCtx = {
  term: WpStoryCategory;
  fields: BlogCategoryFieldUids;
  wp: WordPressClient;
  cs: ContentstackManagementClient;
  map: MappingStore;
  mediaSheetPath: string;
  folderUid: string;
  locale: string | undefined;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
  trackRef: TrackingRow;
  warnings: MigrationWarnings;
  existingEntry?: Record<string, unknown>;
};

async function buildBlogCategoryEntryPayload(ctx: BuildCategoryPayloadCtx): Promise<{
  payload: Record<string, unknown>;
  slug: string;
}> {
  const { term, fields, trackRef, warnings } = ctx;
  const sheet = parseCategorySheetColumns(trackRef);
  const useRest = !isSheetOnlyCategoryRow(trackRef) && trackingRowHasSourceUrl(trackRef);
  const wpName = pickString(term.name) || `Category ${term.id}`;
  const displayName = sheet.categoryName || wpName;
  const slug = pickString(term.slug) || String(term.id);
  const { path: pageUrl, source: pageUrlSource } = resolveMigrationPageUrlForRow(
    trackRef,
    blogCategoryPageUrlPath(slug)
  );
  const seo = withMigrationPageUrl(extractWpCategorySeo(term, slug), pageUrl);
  seo.seoTitleTag = displayName;
  const metaDescription = displayName;
  const ogImageUrl = useRest ? pickYoastOgImageUrl(term) : "";

  const entryPayload: Record<string, unknown> = {
    title: displayName,
  };

  setScalar(entryPayload, fields.cmsAssetName, displayName);
  setScalar(entryPayload, fields.url, pageUrl);
  setScalar(entryPayload, fields.blogCategoryName, displayName);
  setScalar(entryPayload, fields.categoryNameAlias, displayName);
  setScalar(entryPayload, fields.categoryName, displayName);
  setScalar(entryPayload, fields.showUrl, sheet.showUrl);
  if (sheet.categoryLevel) {
    setScalar(entryPayload, fields.categoryLevel, sheet.categoryLevel);
  }

  console.error(
    `[blog-category] wp_id=${term.id} sheet name="${sheet.categoryName || "(none)"}" ` +
      `displayName="${displayName}" show_url=${sheet.showUrl} ` +
      `level=${sheet.categoryLevel || sheet.levelRaw || "(none)"} ` +
      `rest=${useRest ? "yes" : "no"} pageUrl=${pageUrl} (${pageUrlSource})`
  );

  const existingSeoSocial =
    ctx.existingEntry?.[fields.seoSocialGroup] &&
    typeof ctx.existingEntry[fields.seoSocialGroup] === "object" &&
    !Array.isArray(ctx.existingEntry[fields.seoSocialGroup])
      ? (ctx.existingEntry[fields.seoSocialGroup] as Record<string, unknown>)
      : undefined;

  let metaImageAssetUid: string | undefined;

  if (ogImageUrl) {
    const resolved = await tryResolveWpImageAssetFromUrl({
      imageUrl: ogImageUrl,
      wp: ctx.wp,
      cs: ctx.cs,
      map: ctx.map,
      mediaSheetPath: ctx.mediaSheetPath,
      folderUid: ctx.folderUid,
      locale: ctx.locale,
      purpose: `Category ${term.id} meta_image/thumbnail (yoast og_image)`,
      paths: ctx.paths,
      allTracking: ctx.allTracking,
      warnings,
    });
    if (resolved) {
      metaImageAssetUid = resolved.assetUid;
      trackRef.contentstack_asset_uid = resolved.assetUid;
      const existingThumb =
        ctx.existingEntry?.[fields.categoryThumbnail] &&
        typeof ctx.existingEntry[fields.categoryThumbnail] === "object" &&
        !Array.isArray(ctx.existingEntry[fields.categoryThumbnail])
          ? (ctx.existingEntry[fields.categoryThumbnail] as Record<string, unknown>)
          : undefined;
      setCategoryThumbnailField(entryPayload, fields, resolved.assetUid, existingThumb);
      console.error(
        `[blog-category] wp_id=${term.id} category_thumbnail group=${fields.categoryThumbnail} ` +
          `layout=${fields.categoryThumbnailLayout} fileField=${fields.categoryThumbnailFileField} ` +
          `assetUid=${resolved.assetUid} source=${resolved.source} ` +
          `payload=${JSON.stringify(entryPayload[fields.categoryThumbnail])}`
      );
    } else {
      console.error(`[blog-category] wp_id=${term.id} og_image not resolved: ${ogImageUrl}`);
    }
  }

  const existingMetaImageGroup =
    existingSeoSocial?.[fields.metaImageGroup] &&
    typeof existingSeoSocial[fields.metaImageGroup] === "object" &&
    !Array.isArray(existingSeoSocial[fields.metaImageGroup])
      ? (existingSeoSocial[fields.metaImageGroup] as Record<string, unknown>)
      : undefined;

  setCategorySeoGlobal(
    entryPayload,
    fields,
    seo,
    metaDescription,
    existingSeoSocial,
    metaImageAssetUid,
    existingMetaImageGroup,
    { wpId: term.id, entity: "blog-category" }
  );

  console.error(
    `[blog-category] wp_id=${term.id} seo global=${fields.seoSocialGroup} ` +
      `title=${seo.seoTitleTag} page_url=${seo.pageUrlPath} (${pageUrlSource}) ` +
      `metaDescSource=${fields.metaDescriptionSource} metaDesc="${metaDescription}" ` +
      `meta_image.file=${metaImageAssetUid ?? "(none)"}`
  );
  console.error(
    `[blog-category] wp_id=${term.id} seo payload: ${JSON.stringify(entryPayload[fields.seoSocialGroup])}`
  );

  return { payload: entryPayload, slug };
}

function resolveExistingEntryUid(
  mapRecord: { contentstackUid?: string } | undefined,
  trackRef: TrackingRow
): string | undefined {
  return mapRecord?.contentstackUid?.trim() || trackRef.contentstack_entry_uid?.trim() || undefined;
}

/** Link child WP categories (parent > 0) as references on parent entries when enabled. */
async function linkSubCategoriesIfEnabled(
  wp: WordPressClient,
  cs: ContentstackManagementClient,
  map: MappingStore,
  fields: BlogCategoryFieldUids,
  contentTypeUid: string,
  locale: string | undefined,
  allTracking: TrackingRow[],
  restBase: string
): Promise<void> {
  if (process.env.BLOG_CATEGORY_LINK_SUBCATEGORIES !== "1") return;

  const byWpId = new Map<number, string>();
  for (const row of allTracking) {
    if (row.row_kind !== "content" || row.migration_status !== "Pass" || !row.contentstack_entry_uid) {
      continue;
    }
    const rec = map.get("category", row.wp_id, locale);
    const uid = rec?.contentstackUid || row.contentstack_entry_uid;
    if (uid) byWpId.set(row.wp_id, uid);
  }

  const childrenByParent = new Map<number, number[]>();
  for (const row of allTracking) {
    if (row.row_kind !== "content" || row.wp_id <= 0) continue;
    try {
      const rel = `${restBase.replace(/^\//, "")}/${row.wp_id}`;
      const term = await wp.getJson<WpStoryCategory>(rel);
      const parent = typeof term.parent === "number" ? term.parent : 0;
      if (parent > 0) {
        const list = childrenByParent.get(parent) ?? [];
        list.push(term.id);
        childrenByParent.set(parent, list);
      }
    } catch {
      // skip
    }
  }

  for (const [parentWpId, childWpIds] of childrenByParent) {
    const parentUid = byWpId.get(parentWpId);
    if (!parentUid) continue;
    const refs = childWpIds
      .map((id) => {
        const uid = byWpId.get(id);
        return uid ? { uid, contentTypeUid } : undefined;
      })
      .filter((r): r is { uid: string; contentTypeUid: string } => Boolean(r));
    if (refs.length === 0) continue;

    try {
      const existing = (await cs.getEntry(contentTypeUid, parentUid, locale)) as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        ...existing,
        title: String(existing.title ?? "Category"),
      };
      setCategorySubCategoryRefs(payload, fields.blogSubCategories, refs);
      await cs.updateEntry(contentTypeUid, parentUid, payload as { title: string }, locale);
      console.error(
        `[blog-category] parent wp_id=${parentWpId} linked ${refs.length} sub-categor(ies)`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[blog-category] sub-category link parent wp_id=${parentWpId} FAIL: ${msg}`);
    }
  }
}

export async function runMigrateBlogCategoriesFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "BLOG_CATEGORY_TRACK");
  const updateExisting = parseUpdateFlag(argv, "BLOG_CATEGORY_UPDATE");
  const paths = loadPipelinePaths();
  const contentTypeUid = loadBlogCategoryContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set MIGRATION_CONTENT_TYPE_UID=blog_category or CS_CONTENT_TYPE_BLOG_CATEGORY=blog_category");
  }
  const fields = loadBlogCategoryFieldUids();
  const cfg = loadConfig();
  const mongoCfg = loadMongoConfig();
  const mediaSheetPath = process.env.MEDIA_SHEET_PATH ?? "wp-media-mapping.xlsx";

  const auth =
    cfg.wp.user && cfg.wp.applicationPassword
      ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
      : undefined;
  const wp = new WordPressClient(cfg.wp.baseUrl, auth);
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });
  const map = await MappingStore.load(cfg.mappingFile);
  const locale = process.env.CONTENTSTACK_LOCALE;
  const folderUid = await ensureAssetFolderUid(map, cs);

  if (updateExisting) {
    console.error("[migrate-blog-categories] --update: will PUT existing entries when UID is known.");
  }

  const allTracking = loadAllTracking(paths);
  const selected = selectCategoryContentRows(
    allTracking,
    paths.migrateStartSheet,
    sel.mode as SelectionMode,
    sel,
    updateExisting
  );

  if (selected.length === 0) {
    console.error("No story_category tracking rows selected for this sheet.");
    await closeMongo();
    return;
  }

  let ok = 0;
  const restBaseDefault = paths.wpRestPath;

  for (const tRow of selected) {
    const trackRef = allTracking.find(
      (r) =>
        r.row_kind === "content" &&
        r.source_sheet === tRow.source_sheet &&
        r.wp_id === tRow.wp_id &&
        r.url === tRow.url
    );
    if (!trackRef) continue;
    const warnings = new MigrationWarnings();
    try {
      const mapRecord = map.get("category", tRow.wp_id, locale);
      const existingUid = resolveExistingEntryUid(mapRecord, trackRef);

      if (!updateExisting && existingUid) {
        trackRef.contentstack_entry_uid = existingUid;
        trackRef.migration_status = "Pass";
        trackRef.migration_message = "Already in JSON map (use --update to refresh from WordPress)";
        trackRef.updated_at = new Date().toISOString();
        trackRef.target_url = buildContentstackEntryTargetUrl({
          apiHost: cfg.contentstack.apiHost,
          stackApiKey: cfg.contentstack.stackApiKey,
          contentTypeUid,
          entryUid: existingUid,
          locale,
        });
        await persistOneRow(paths, allTracking, trackRef, mongoCfg);
        ok += 1;
        continue;
      }

      const restBase = (trackRef.wp_rest_path || restBaseDefault).replace(/\/$/, "");
      const sheetOnly = isSheetOnlyCategoryRow(tRow);
      let term: WpStoryCategory;
      if (sheetOnly) {
        term = buildSheetOnlyCategoryTerm(trackRef, tRow.wp_id);
        console.error(
          `[blog-category] wp_id=${tRow.wp_id} sheet-only (no WordPress REST) name="${term.name}" slug=${term.slug}`
        );
      } else {
        const rel = `${restBase.replace(/^\//, "")}/${tRow.wp_id}`;
        term = await wp.getJson<WpStoryCategory>(rel);
      }

      let existingEntry: Record<string, unknown> | undefined;
      if (existingUid) {
        try {
          existingEntry = (await cs.getEntry(contentTypeUid, existingUid, locale)) as Record<string, unknown>;
        } catch {
          existingEntry = undefined;
        }
      }

      const { payload: entryPayload, slug } = await buildBlogCategoryEntryPayload({
        term,
        fields,
        wp,
        cs,
        map,
        mediaSheetPath,
        folderUid,
        locale,
        paths,
        allTracking,
        trackRef,
        warnings,
        existingEntry,
      });

      if (updateExisting && !existingUid) {
        throw new Error(
          "No Contentstack entry UID in map or tracking; run migrate without --update first"
        );
      }

      const logCtx = { wpId: tRow.wp_id, entity: "blog-category" };
      const { uid: entryUid, warning: pageUrlWarning } = await upsertContentstackEntryWithSeoFallback({
        cs,
        contentTypeUid,
        payload: entryPayload as { title: string },
        locale,
        existingUid: updateExisting ? existingUid : undefined,
        seoFields: fields,
        logContext: logCtx,
      });

      const imageWarnings = warnings.join();
      if (imageWarnings) {
        console.error(`[blog-category] wp_id=${tRow.wp_id} image warnings: ${imageWarnings}`);
      }
      trackRef.migration_message = mergeMigrationMessages(
        imageWarnings,
        pageUrlWarning,
        updateExisting ? "Updated from WordPress (--update)" : undefined
      );
      if (pageUrlWarning) {
        console.error(`[blog-category] wp_id=${tRow.wp_id} WARNING: ${pageUrlWarning}`);
      }
      console.error(
        `[blog-category] wp_id=${tRow.wp_id} ${updateExisting ? "UPDATED" : "CREATED"} entry ${entryUid}`
      );

      map.set({
        wpId: tRow.wp_id,
        kind: "category",
        contentstackUid: entryUid,
        sourceKey: slug,
        migratedAt: new Date().toISOString(),
        locale,
      });
      await map.save();

      trackRef.contentstack_entry_uid = entryUid;
      trackRef.content_type_uid = contentTypeUid;
      trackRef.migration_status = "Pass";
      trackRef.updated_at = new Date().toISOString();
      trackRef.target_url = buildContentstackEntryTargetUrl({
        apiHost: cfg.contentstack.apiHost,
        stackApiKey: cfg.contentstack.stackApiKey,
        contentTypeUid,
        entryUid,
        locale,
      });
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      trackRef.migration_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.target_url = "";
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      console.error(`[blog-category] wp_id=${tRow.wp_id} FAIL: ${msg}`);
    }
  }

  const restBase =
    selected[0]?.wp_rest_path?.replace(/\/$/, "") ||
    allTracking.find((r) => r.source_sheet === paths.migrateStartSheet)?.wp_rest_path?.replace(/\/$/, "") ||
    restBaseDefault.replace(/\/$/, "");
  await linkSubCategoriesIfEnabled(wp, cs, map, fields, contentTypeUid, locale, allTracking, restBase);

  await closeMongo();
  console.error(
    `[migrate-blog-categories] Finished. ${ok}/${selected.length} OK for sheet "${paths.migrateStartSheet}".`
  );
}
