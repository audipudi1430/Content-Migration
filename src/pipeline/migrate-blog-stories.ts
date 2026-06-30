import type { WpEntityKind } from "../mapping-store.js";
import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ensureAssetFolderUid } from "../media/migrate-media-core.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, parseUpdateFlag, type SelectionMode } from "./args.js";
import {
  blogArticlePageUrlPath,
  loadBlogAuthorRefContentTypeUid,
  loadBlogCategoryRefContentTypeUid,
  loadBlogContentTypeUid,
  loadBlogFieldUids,
  loadBlogFeaturedImageTarget,
  loadBlogMetaKeys,
  loadBlogSelectDefaults,
  loadBlogSeriesMappingKind,
  loadBlogSeriesRefContentTypeUid,
  loadBlogWpTaxonomyAuthor,
  loadBlogWpTaxonomyCategory,
} from "./blog-config.js";
import { loadBlogBodyBlockUids, loadBlogBodySource } from "./blog-body-config.js";
import {
  buildBodyContentFromWpStory,
  logWpStoryContentForMapping,
  modularBodyGlobalValue,
} from "./blog-body-content.js";
import { resolveSeoMetaDescription } from "./blog-author-seo.js";
import {
  buildBlogEntryPayload,
  pickMetaString,
  pickRenderedTitle,
  pickWpTermIds,
  pickFeaturedMediaId,
  setBannerImageField,
  setBlogSeoGlobal,
  setModularBodyField,
  setScalar,
  setThumbnailField,
  pickExistingThumbnailFocalPoint,
  type ThumbnailFieldOptions,
} from "./blog-payload.js";
import { pickStoryThumbnailSource } from "./story-thumbnail-source.js";
import {
  fetchWpStoryForMigration,
  loadBlogFetchBySlug,
  storySlugForFetch,
} from "./blog-story-fetch.js";
import { extractWpStorySeo, pickYoastOgImageUrl } from "./blog-seo.js";
import { resolveMigrationPageUrlForRow, withMigrationPageUrl } from "./migration-url.js";
import { normalizeWpText } from "./contentstack-rte.js";
import { upsertContentstackEntryWithSeoFallback } from "./contentstack-entry-upsert.js";
import { MigrationWarnings, mergeMigrationMessages } from "./image-size-limit.js";
import { tryResolveWpImageAssetFromUrl } from "./resolve-wp-image-from-url.js";
import { tryResolveWpImageAssetUid } from "./resolve-wp-image-asset.js";
import { tryResolveVideoEntryForBody } from "./ensure-video-entry.js";
import {
  isSheetNoneValue,
  parseCommaSeparatedLabels,
  parseStorySheetColumns,
  storySheetCategoryLabels,
  storySheetHasCategoryColumns,
} from "./blog-story-sheet.js";
import {
  resolveBlogAuthorUidByName,
  resolveBlogCategoryUidsByNames,
} from "./resolve-entry-ref-by-name.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { buildContentstackEntryTargetUrl } from "./cs-target-url.js";
import type { TrackingRow } from "./types.js";

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function resolveExistingEntryUid(
  mapRecord: { contentstackUid?: string } | undefined,
  trackRef: TrackingRow
): string | undefined {
  return mapRecord?.contentstackUid?.trim() || trackRef.contentstack_entry_uid?.trim() || undefined;
}

function resolveMappedRefUid(
  map: MappingStore,
  kind: WpEntityKind,
  wpId: number,
  locale: string | undefined
): string | undefined {
  const record = map.get(kind, wpId, locale);
  return record?.contentstackUid?.trim() || undefined;
}

function allMappedRefs(
  map: MappingStore,
  kind: WpEntityKind,
  wpIds: number[],
  locale: string | undefined,
  logLabel: string,
  wpStoryId: number,
  warnings?: MigrationWarnings
): string[] {
  const uids: string[] = [];
  const missing: number[] = [];
  for (const wpId of wpIds) {
    const uid = resolveMappedRefUid(map, kind, wpId, locale);
    if (uid) uids.push(uid);
    else missing.push(wpId);
  }
  if (missing.length > 0) {
    const msg =
      `no Contentstack mapping for ${logLabel} wp_id(s)=${missing.join(",")} (run category/author migration first)`;
    warnings?.add(msg);
    console.error(`[blog] wp_id=${wpStoryId} WARNING: ${msg}`);
  }
  return uids;
}

export async function runMigrateBlogStoriesFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "BLOG_TRACK");
  const updateExisting = parseUpdateFlag(argv, "BLOG_UPDATE");
  const paths = loadPipelinePaths();
  const contentTypeUid = loadBlogContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set MIGRATION_CONTENT_TYPE_UID=blog or CS_CONTENT_TYPE_BLOG=blog");
  }

  const fields = loadBlogFieldUids();
  const selectDefaults = loadBlogSelectDefaults();
  const metaKeys = loadBlogMetaKeys();
  const categoryRefContentTypeUid = loadBlogCategoryRefContentTypeUid();
  const authorRefContentTypeUid = loadBlogAuthorRefContentTypeUid();
  const seriesRefContentTypeUid = loadBlogSeriesRefContentTypeUid();
  const seriesMappingKind = loadBlogSeriesMappingKind();
  const wpTaxonomyCategory = loadBlogWpTaxonomyCategory();
  const wpTaxonomyAuthor = loadBlogWpTaxonomyAuthor();

  const bodyUids = loadBlogBodyBlockUids();
  const bodySource = loadBlogBodySource();
  const fetchBySlug = loadBlogFetchBySlug();
  const featuredImageTarget = loadBlogFeaturedImageTarget();

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

  const restSeg = paths.wpRestPath.replace(/\/$/, "").split("/").pop() ?? "";
  if (restSeg !== "story" && restSeg !== "stories") {
    console.error(
      `[migrate-blog-stories] Warning: MIGRATION_WP_REST_PATH last segment is "${restSeg}", expected story. Proceeding anyway.`
    );
  }

  if (updateExisting) {
    console.error("[migrate-blog-stories] --update: will PUT existing Contentstack entries when UID is known.");
  }
  if (fetchBySlug) {
    console.error(
      "[migrate-blog-stories] Fetching stories via REST ?slug= (content.blocks + content.rendered)."
    );
  }

  const allTracking = loadAllTracking(paths);
  const selected = selectContentRows(
    allTracking,
    paths.migrateStartSheet,
    sel.mode as SelectionMode,
    sel,
    updateExisting
  );

  if (selected.length === 0) {
    console.error("No story tracking rows selected for this sheet.");
    await closeMongo();
    return;
  }

  let ok = 0;
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
      const mapRecord = map.get("story", tRow.wp_id, locale);
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

      const restBase = (trackRef.wp_rest_path || paths.wpRestPath).replace(/\/$/, "");
      const { story, fetchUrl } = await fetchWpStoryForMigration(
        wp,
        restBase,
        trackRef,
        tRow.wp_id,
        fetchBySlug
      );
      console.error(
        `[blog] wp_id=${tRow.wp_id} WP GET ${fetchUrl} ` +
          `(slug=${storySlugForFetch(trackRef) || "(from response)"})`
      );
      logWpStoryContentForMapping(tRow.wp_id, story);

      let existingEntry: Record<string, unknown> | undefined;
      if (existingUid) {
        try {
          existingEntry = (await cs.getEntry(contentTypeUid, existingUid, locale)) as Record<
            string,
            unknown
          >;
        } catch {
          existingEntry = undefined;
        }
      }

      const slug = pickString(story.slug) || String(tRow.wp_id);
      const sheetCols = parseStorySheetColumns(trackRef);
      const wpTitle =
        pickRenderedTitle(story.title) ||
        normalizeWpText(pickString(story.name)) ||
        `Story ${story.id ?? tRow.wp_id}`;
      const cmsTitle = wpTitle;
      const headlineFromSheet = sheetCols.headline.trim() || undefined;
      const articleHeadline = headlineFromSheet || cmsTitle;
      if (headlineFromSheet) {
        console.error(`[blog] wp_id=${tRow.wp_id} headline from sheet="${headlineFromSheet}"`);
      }

      const bylineOverride =
        sheetCols.namedAuthorColumnPresent && !isSheetNoneValue(sheetCols.namedAuthor)
          ? sheetCols.namedAuthor
          : undefined;
      if (bylineOverride) {
        console.error(`[blog] wp_id=${tRow.wp_id} byline="${bylineOverride}" (sheet Named Author)`);
      }

      const { path: pageUrl, source: pageUrlSource } = resolveMigrationPageUrlForRow(
        trackRef,
        blogArticlePageUrlPath(slug)
      );
      if (pageUrlSource === "fallback") {
        warnings.add(
          "no new_url on tracking row; using fallback url (re-run pipeline:extract after adding new url column)"
        );
        console.error(
          `[blog] wp_id=${tRow.wp_id} WARNING: no new_url on tracking row; ` +
            `using fallback url=${pageUrl} (re-run pipeline:extract after adding new url column)`
        );
      }

      let authorRefUids: string[] = [];
      if (sheetCols.namedAuthorColumnPresent) {
        if (!isSheetNoneValue(sheetCols.namedAuthor)) {
          const authorUid = await resolveBlogAuthorUidByName({
            name: sheetCols.namedAuthor,
            cs,
            authorContentTypeUid: authorRefContentTypeUid,
            allTracking,
            locale,
            warnings,
          });
          if (authorUid) {
            authorRefUids = [authorUid];
            console.error(
              `[blog] wp_id=${tRow.wp_id} blog_author_profile="${sheetCols.namedAuthor}" uid=${authorUid} (sheet)`
            );
          }
        } else {
          console.error(`[blog] wp_id=${tRow.wp_id} Named Author=None; blog_author_profile omitted`);
        }
      } else {
        const authorWpIds = pickWpTermIds(story[wpTaxonomyAuthor]);
        authorRefUids = allMappedRefs(
          map,
          "story_author",
          authorWpIds,
          locale,
          wpTaxonomyAuthor,
          tRow.wp_id,
          warnings
        );
      }

      let categoryRefUids: string[] = [];
      if (storySheetHasCategoryColumns(sheetCols)) {
        const categoryLabels = storySheetCategoryLabels(sheetCols);
        if (categoryLabels.length > 0) {
          categoryRefUids = await resolveBlogCategoryUidsByNames({
            names: categoryLabels,
            cs,
            categoryContentTypeUid: categoryRefContentTypeUid,
            allTracking,
            locale,
            warnings,
          });
          console.error(
            `[blog] wp_id=${tRow.wp_id} blog_category from sheet L1/L2/Series: ` +
              `labels=${categoryLabels.join(" | ")} uids=${categoryRefUids.join(",") || "(none)"}`
          );
        }
      } else {
        const categoryWpIds = pickWpTermIds(story[wpTaxonomyCategory]);
        categoryRefUids = allMappedRefs(
          map,
          "category",
          categoryWpIds,
          locale,
          wpTaxonomyCategory,
          tRow.wp_id,
          warnings
        );
      }

      let blogTopics: string[] | undefined;
      if (sheetCols.l3ColumnPresent) {
        blogTopics = parseCommaSeparatedLabels(sheetCols.l3);
        console.error(
          `[blog] wp_id=${tRow.wp_id} blog_topics from sheet L3: ${blogTopics.length ? blogTopics.join(", ") : "(empty)"}`
        );
      }

      let seriesRefUid: string | undefined;
      if (!sheetCols.seriesColumnPresent && seriesRefContentTypeUid && metaKeys.seriesLabel) {
        const meta =
          story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
            ? (story.meta as Record<string, unknown>)
            : undefined;
        const seriesRaw = pickMetaString(meta, metaKeys.seriesLabel);
        const seriesWpId = Number(seriesRaw);
        if (Number.isFinite(seriesWpId) && seriesWpId > 0) {
          seriesRefUid = resolveMappedRefUid(map, seriesMappingKind, Math.floor(seriesWpId), locale);
          if (!seriesRefUid) {
            warnings.add(`series_label: no Contentstack mapping for series wp_id=${seriesWpId}`);
            console.error(
              `[blog] wp_id=${tRow.wp_id} WARNING: no Contentstack mapping for series wp_id=${seriesWpId}`
            );
          }
        }
      }

      const entryPayload = buildBlogEntryPayload({
        story,
        fields,
        pageUrl,
        cmsTitle,
        headlineOverride: headlineFromSheet,
        bylineOverride,
        categoryRefUids,
        categoryRefContentTypeUid,
        authorRefUids,
        authorRefContentTypeUid,
        blogTopics,
        seriesRefUid,
        seriesRefContentTypeUid: seriesRefContentTypeUid || undefined,
        selectDefaults,
        metaKeys,
      });

      const thumbSource = pickStoryThumbnailSource(story);
      const thumbnailMediaId = thumbSource?.attachmentId ?? pickFeaturedMediaId(story);
      if (thumbnailMediaId) {
        const resolved = await tryResolveWpImageAssetUid({
          attachmentId: thumbnailMediaId,
          wp,
          cs,
          map,
          mediaSheetPath,
          folderUid,
          locale,
          purpose: `Story ${tRow.wp_id} ${featuredImageTarget} (${thumbSource?.source ?? "featured_media"})`,
          paths,
          allTracking,
          warnings,
        });
        if (resolved) {
          const { assetUid, source } = resolved;
          if (featuredImageTarget === "banner_image") {
            const existingBannerImage =
              existingEntry?.[fields.bannerImage] &&
              typeof existingEntry[fields.bannerImage] === "object" &&
              !Array.isArray(existingEntry[fields.bannerImage])
                ? (existingEntry[fields.bannerImage] as Record<string, unknown>)
                : undefined;
            setBannerImageField(entryPayload, fields, assetUid, existingBannerImage);
            console.error(
              `[blog] wp_id=${tRow.wp_id} banner_image group=${fields.bannerImage} ` +
                `layout=${fields.bannerImageLayout} fileField=${fields.bannerImageFileField} ` +
                `wp_media=${thumbnailMediaId} source=${thumbSource?.source ?? "featured_media"} ` +
                `assetUid=${assetUid} resolve=${source} ` +
                `payload=${JSON.stringify(entryPayload[fields.bannerImage])}`
            );
          } else {
            const existingThumbnail =
              existingEntry?.[fields.thumbnail] &&
              typeof existingEntry[fields.thumbnail] === "object" &&
              !Array.isArray(existingEntry[fields.thumbnail])
                ? (existingEntry[fields.thumbnail] as Record<string, unknown>)
                : undefined;
            const thumbnailOptions: ThumbnailFieldOptions = {
              focalPoint:
                thumbSource?.focalPoint ??
                pickExistingThumbnailFocalPoint(existingThumbnail, fields),
            };
            if (!fields.thumbnailPresetExtensionUid.trim()) {
              warnings.add(
                `article_image Image Preset Picker missing BLOG_THUMBNAIL_PRESET_EXTENSION_UID ` +
                  `(source=${thumbSource?.source ?? "featured_media"})`
              );
            }
            if (thumbnailOptions.focalPoint) {
              if (!fields.thumbnailPresetUid.trim()) {
                warnings.add(
                  `thumbnail focal-point set but BLOG_THUMBNAIL_PRESET_UID is empty; ` +
                    `preset lookup may be missing in Contentstack`
                );
              }
            }
            setThumbnailField(entryPayload, fields, assetUid, existingThumbnail, thumbnailOptions);
            const fp = thumbnailOptions.focalPoint;
            console.error(
              `[blog] wp_id=${tRow.wp_id} article_image global=${fields.thumbnail} ` +
                `presetField=${fields.thumbnailImagePresetField} ` +
                `wp_media=${thumbnailMediaId} block=${thumbSource?.source ?? "featured_media"} ` +
                `focal_point=${fp ? `x=${fp.x} y=${fp.y}` : "(none)"} ` +
                `assetUid=${assetUid} resolve=${source} ` +
                `payload=${JSON.stringify(entryPayload[fields.thumbnail])}`
            );
          }
          trackRef.featured_media_wp_id = String(thumbnailMediaId);
          trackRef.contentstack_asset_uid = assetUid;
        } else if (warnings.hasSizeSkipFor(thumbnailMediaId)) {
          trackRef.featured_media_wp_id = String(thumbnailMediaId);
          console.error(
            `[blog] wp_id=${tRow.wp_id} WARNING: ${featuredImageTarget === "banner_image" ? fields.bannerImage : fields.thumbnail} omitted (image size limit)`
          );
        } else {
          throw new Error(
            `${featuredImageTarget === "banner_image" ? fields.bannerImage : fields.thumbnail} ` +
              `could not resolve WordPress media ${thumbnailMediaId} (from ${thumbSource?.source ?? "featured_media"})`
          );
        }
      } else {
        console.error(
          `[blog] wp_id=${tRow.wp_id} ${featuredImageTarget} skipped: no hero block, featured_media, or media block`
        );
      }

      const bodyResult = await buildBodyContentFromWpStory(
        story,
        bodyUids,
        async ({ attachmentId, imageUrl, purpose }) => {
          if (attachmentId) {
            const resolved = await tryResolveWpImageAssetUid({
              attachmentId,
              wp,
              cs,
              map,
              mediaSheetPath,
              folderUid,
              locale,
              purpose: `Story ${tRow.wp_id} ${purpose}`,
              paths,
              allTracking,
              warnings,
            });
            return resolved?.assetUid;
          }
          if (imageUrl) {
            const resolved = await tryResolveWpImageAssetFromUrl({
              imageUrl,
              wp,
              cs,
              map,
              mediaSheetPath,
              folderUid,
              locale,
              purpose: `Story ${tRow.wp_id} ${purpose}`,
              paths,
              allTracking,
              warnings,
            });
            return resolved?.assetUid;
          }
          return undefined;
        },
        bodySource,
        (msg) => console.error(`[blog] wp_id=${tRow.wp_id} body: ${msg}`),
        async ({ attachmentId, embedUrl, providerSlug, purpose }) => {
          try {
            return await tryResolveVideoEntryForBody({
              attachmentId,
              embedUrl,
              providerSlug,
              purpose: `Story ${tRow.wp_id} ${purpose}`,
              cs,
              map,
              mediaSheetPath,
              locale,
              paths,
              allTracking,
              warnings,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[blog] wp_id=${tRow.wp_id} body video FAIL: ${msg.slice(0, 200)}`);
            return undefined;
          }
        },
        { articleHeadline }
      );

      if (bodyResult.blocks.length > 0) {
        setModularBodyField(
          entryPayload,
          bodyUids.fieldUid,
          modularBodyGlobalValue(bodyResult.blocks, bodyUids)
        );
        console.error(
          `[blog] wp_id=${tRow.wp_id} modular_body blocks=${bodyResult.blocks.length} ` +
            `field=${bodyUids.fieldUid}.${bodyUids.modularBlocksFieldUid}`
        );
      }

      const seo = withMigrationPageUrl(extractWpStorySeo(story, slug), pageUrl);
      const metaDescription = resolveSeoMetaDescription(cmsTitle, seo, fields.metaDescriptionSource);
      const ogImageUrl = pickYoastOgImageUrl(story);

      const existingSeoSocial =
        existingEntry?.[fields.seoSocialGroup] &&
        typeof existingEntry[fields.seoSocialGroup] === "object" &&
        !Array.isArray(existingEntry[fields.seoSocialGroup])
          ? (existingEntry[fields.seoSocialGroup] as Record<string, unknown>)
          : undefined;

      let metaImageAssetUid: string | undefined;
      if (ogImageUrl) {
        const warnBefore = warnings.count;
        const resolved = await tryResolveWpImageAssetFromUrl({
          imageUrl: ogImageUrl,
          wp,
          cs,
          map,
          mediaSheetPath,
          folderUid,
          locale,
          purpose: `Story ${tRow.wp_id} seo.meta_image (yoast og_image)`,
          paths,
          allTracking,
          warnings,
        });
        if (resolved) {
          metaImageAssetUid = resolved.assetUid;
          trackRef.contentstack_asset_uid = resolved.assetUid;
        } else if (warnings.count > warnBefore) {
          console.error(
            `[blog] wp_id=${tRow.wp_id} WARNING: seo.meta_image omitted (image size limit)`
          );
        } else {
          warnings.add(`seo.meta_image: og_image not resolved (${ogImageUrl})`);
          console.error(
            `[blog] wp_id=${tRow.wp_id} WARNING: seo.meta_image omitted (og_image not resolved)`
          );
        }
      }

      const existingMetaImageGroup =
        existingSeoSocial?.[fields.metaImageGroup] &&
        typeof existingSeoSocial[fields.metaImageGroup] === "object" &&
        !Array.isArray(existingSeoSocial[fields.metaImageGroup])
          ? (existingSeoSocial[fields.metaImageGroup] as Record<string, unknown>)
          : undefined;

      setBlogSeoGlobal(
        entryPayload,
        fields,
        seo,
        metaDescription,
        existingSeoSocial,
        metaImageAssetUid,
        existingMetaImageGroup,
        { wpId: tRow.wp_id, entity: "blog" }
      );

      console.error(
        `[blog] wp_id=${tRow.wp_id} title="${cmsTitle}" url=${pageUrl} (${pageUrlSource}) ` +
          `category=${categoryRefUids.length > 0 ? categoryRefUids.join(",") : "(none)"} ` +
            `author=${authorRefUids.length > 0 ? authorRefUids.join(",") : "(none)"} ` +
          `body=${bodyResult.stats.source} blocks=${bodyResult.blocks.length} ` +
          `(text=${bodyResult.stats.text} image=${bodyResult.stats.image} ` +
          `testimonial=${bodyResult.stats.testimonial} video=${bodyResult.stats.video} ` +
          `skipped=${bodyResult.stats.skipped}) ` +
          `sub_header="${pickMetaString(
            story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
              ? (story.meta as Record<string, unknown>)
              : undefined,
            metaKeys.subHeader
          )}"`
      );
      console.error(
        `[blog] wp_id=${tRow.wp_id} seo global=${fields.seoSocialGroup} ` +
          `title=${seo.seoTitleTag} page_url=${seo.pageUrlPath} ` +
          `metaDescSource=${fields.metaDescriptionSource} metaDesc="${metaDescription}" ` +
          `meta_image.file=${metaImageAssetUid ?? "(none)"}`
      );
      console.error(
        `[blog] wp_id=${tRow.wp_id} seo payload: ${JSON.stringify(entryPayload[fields.seoSocialGroup])}`
      );

      if (updateExisting && !existingUid) {
        throw new Error(
          "No Contentstack entry UID in map or tracking; run migrate without --update first"
        );
      }

      const logCtx = { wpId: tRow.wp_id, entity: "blog" };
      const { uid: entryUid, warning: pageUrlWarning } = await upsertContentstackEntryWithSeoFallback({
        cs,
        contentTypeUid,
        payload: entryPayload as { title: string },
        locale,
        existingUid: updateExisting ? existingUid : undefined,
        seoFields: fields,
        fileImageFields: {
          ...(featuredImageTarget === "banner_image"
            ? {
                bannerImage: fields.bannerImage,
                bannerImageFileField: fields.bannerImageFileField,
              }
            : {
                thumbnail: fields.thumbnail,
                thumbnailImagePresetField: fields.thumbnailImagePresetField,
                thumbnailPresetImageField: fields.thumbnailPresetImageField,
              }),
          seoSocialGroup: fields.seoSocialGroup,
          metaImageGroup: fields.metaImageGroup,
          metaImageFileField: fields.metaImageFileField,
          modularBodyFieldUid: bodyUids.fieldUid,
          modularBlocksFieldUid: bodyUids.modularBlocksFieldUid,
          modularBodyImageBlockUid: bodyUids.image.blockUid,
          modularBodyImageFileField: bodyUids.image.file,
        },
        logContext: logCtx,
        resolveDuplicateTitle: true,
      });

      const allWarnings = warnings.join();
      if (allWarnings) {
        console.error(`[blog] wp_id=${tRow.wp_id} warnings: ${allWarnings}`);
      }

      trackRef.migration_message = mergeMigrationMessages(
        allWarnings,
        pageUrlWarning,
        updateExisting ? "Updated from WordPress (--update)" : undefined
      );
      if (pageUrlWarning) {
        console.error(`[blog] wp_id=${tRow.wp_id} WARNING: ${pageUrlWarning}`);
      }
      console.error(
        `[blog] wp_id=${tRow.wp_id} ${updateExisting ? "UPDATED" : "CREATED"} entry ${entryUid}`
      );

      map.set({
        wpId: tRow.wp_id,
        kind: "story",
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
      console.error(`[blog] wp_id=${tRow.wp_id} FAIL: ${msg}`);
    }
  }

  await closeMongo();
  console.error(
    `[migrate-blog-stories] Finished. ${ok}/${selected.length} OK for sheet "${paths.migrateStartSheet}".`
  );
}
