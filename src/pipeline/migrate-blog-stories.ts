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
  loadBlogMetaKeys,
  loadBlogSelectDefaults,
  loadBlogSeriesMappingKind,
  loadBlogSeriesRefContentTypeUid,
  loadBlogWpTaxonomyAuthor,
  loadBlogWpTaxonomyCategory,
} from "./blog-config.js";
import { loadBlogBodyBlockUids, loadBlogBodySource } from "./blog-body-config.js";
import { buildBodyContentFromWpStory, logWpStoryContentForMapping } from "./blog-body-content.js";
import { resolveSeoMetaDescription } from "./blog-author-seo.js";
import {
  buildBlogEntryPayload,
  pickMetaString,
  pickRenderedTitle,
  pickWpTermIds,
  pickFeaturedMediaId,
  setBannerImageField,
  setBlogSeoGlobal,
  setScalar,
} from "./blog-payload.js";
import {
  fetchWpStoryForMigration,
  loadBlogFetchBySlug,
  storySlugForFetch,
} from "./blog-story-fetch.js";
import { extractWpStorySeo, pickYoastOgImageUrl } from "./blog-seo.js";
import { upsertContentstackEntryWithSeoFallback } from "./contentstack-entry-upsert.js";
import { resolveWpImageAssetFromUrl } from "./resolve-wp-image-from-url.js";
import { resolveWpImageAssetUid } from "./resolve-wp-image-asset.js";
import { resolveWpVideoEntryUid } from "./resolve-wp-video-entry.js";
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

function firstMappedRef(
  map: MappingStore,
  kind: WpEntityKind,
  wpIds: number[],
  locale: string | undefined,
  logLabel: string,
  wpStoryId: number
): string | undefined {
  for (const wpId of wpIds) {
    const uid = resolveMappedRefUid(map, kind, wpId, locale);
    if (uid) return uid;
  }
  if (wpIds.length > 0) {
    console.error(
      `[blog] wp_id=${wpStoryId} WARNING: no Contentstack mapping for ${logLabel} wp_id(s)=${wpIds.join(",")} ` +
        `(run category/author migration first)`
    );
  }
  return undefined;
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
      const cmsTitle = pickRenderedTitle(story.title) || `Story ${story.id ?? tRow.wp_id}`;
      const pageUrl = blogArticlePageUrlPath(slug);

      const categoryWpIds = pickWpTermIds(story[wpTaxonomyCategory]);
      const authorWpIds = pickWpTermIds(story[wpTaxonomyAuthor]);

      const categoryRefUid = firstMappedRef(
        map,
        "category",
        categoryWpIds,
        locale,
        wpTaxonomyCategory,
        tRow.wp_id
      );
      const authorRefUid = firstMappedRef(
        map,
        "story_author",
        authorWpIds,
        locale,
        wpTaxonomyAuthor,
        tRow.wp_id
      );

      let seriesRefUid: string | undefined;
      if (seriesRefContentTypeUid && metaKeys.seriesLabel) {
        const meta =
          story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
            ? (story.meta as Record<string, unknown>)
            : undefined;
        const seriesRaw = pickMetaString(meta, metaKeys.seriesLabel);
        const seriesWpId = Number(seriesRaw);
        if (Number.isFinite(seriesWpId) && seriesWpId > 0) {
          seriesRefUid = resolveMappedRefUid(map, seriesMappingKind, Math.floor(seriesWpId), locale);
          if (!seriesRefUid) {
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
        categoryRefUid,
        categoryRefContentTypeUid,
        authorRefUid,
        authorRefContentTypeUid,
        seriesRefUid,
        seriesRefContentTypeUid: seriesRefContentTypeUid || undefined,
        selectDefaults,
        metaKeys,
      });

      const featuredMediaId = pickFeaturedMediaId(story);
      if (featuredMediaId) {
        const { assetUid, source } = await resolveWpImageAssetUid({
          attachmentId: featuredMediaId,
          wp,
          cs,
          map,
          mediaSheetPath,
          folderUid,
          locale,
          purpose: `Story ${tRow.wp_id} banner_image (featured_media)`,
          paths,
          allTracking,
        });
        const existingBannerImage =
          existingEntry?.[fields.bannerImage] &&
          typeof existingEntry[fields.bannerImage] === "object" &&
          !Array.isArray(existingEntry[fields.bannerImage])
            ? (existingEntry[fields.bannerImage] as Record<string, unknown>)
            : undefined;
        setBannerImageField(entryPayload, fields, assetUid, existingBannerImage);
        trackRef.featured_media_wp_id = String(featuredMediaId);
        trackRef.contentstack_asset_uid = assetUid;
        console.error(
          `[blog] wp_id=${tRow.wp_id} banner_image group=${fields.bannerImage} ` +
            `layout=${fields.bannerImageLayout} fileField=${fields.bannerImageFileField} ` +
            `featured_media=${featuredMediaId} assetUid=${assetUid} source=${source} ` +
            `payload=${JSON.stringify(entryPayload[fields.bannerImage])}`
        );
      } else {
        console.error(`[blog] wp_id=${tRow.wp_id} banner_image skipped: no featured_media`);
      }

      const bodyResult = await buildBodyContentFromWpStory(
        story,
        bodyUids,
        async ({ attachmentId, imageUrl, purpose }) => {
          try {
            if (attachmentId) {
              const resolved = await resolveWpImageAssetUid({
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
              });
              return resolved.assetUid;
            }
            if (imageUrl) {
              const resolved = await resolveWpImageAssetFromUrl({
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
              });
              return resolved?.assetUid;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[blog] wp_id=${tRow.wp_id} body image FAIL: ${msg.slice(0, 200)}`);
          }
          return undefined;
        },
        bodySource,
        (msg) => console.error(`[blog] wp_id=${tRow.wp_id} body: ${msg}`),
        async ({ attachmentId, embedUrl, purpose }) => {
          if (attachmentId) {
            const resolved = resolveWpVideoEntryUid({
              attachmentId,
              map,
              mediaSheetPath,
              locale,
              paths,
              allTracking,
            });
            if (resolved) return resolved.entryUid;
          }
          if (embedUrl) {
            console.error(
              `[blog] wp_id=${tRow.wp_id} body video skipped (${purpose}): embed URL not mapped — ${embedUrl}`
            );
          }
          return undefined;
        }
      );

      if (bodyResult.blocks.length > 0) {
        setScalar(entryPayload, bodyUids.fieldUid, bodyResult.blocks);
      }

      const seo = extractWpStorySeo(story, slug);
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
        const resolved = await resolveWpImageAssetFromUrl({
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
        });
        if (resolved) {
          metaImageAssetUid = resolved.assetUid;
          trackRef.contentstack_asset_uid = resolved.assetUid;
        } else {
          console.error(`[blog] wp_id=${tRow.wp_id} og_image not resolved: ${ogImageUrl}`);
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
        `[blog] wp_id=${tRow.wp_id} title="${cmsTitle}" url=${pageUrl} ` +
          `category=${categoryRefUid ?? "(none)"} author=${authorRefUid ?? "(none)"} ` +
          `body=${bodyResult.stats.source} blocks=${bodyResult.blocks.length} ` +
          `(text=${bodyResult.stats.text} image=${bodyResult.stats.image} ` +
          `video=${bodyResult.stats.video} skipped=${bodyResult.stats.skipped}) ` +
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
        logContext: logCtx,
      });

      if (pageUrlWarning) {
        trackRef.migration_message = pageUrlWarning;
        console.error(`[blog] wp_id=${tRow.wp_id} WARNING: ${pageUrlWarning}`);
      } else if (updateExisting) {
        trackRef.migration_message = "Updated from WordPress (--update)";
      } else {
        trackRef.migration_message = "";
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
