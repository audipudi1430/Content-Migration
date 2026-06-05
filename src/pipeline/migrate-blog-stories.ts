import type { WpEntityKind } from "../mapping-store.js";
import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
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
import {
  buildBlogEntryPayload,
  pickMetaString,
  pickRenderedTitle,
  pickWpTermIds,
} from "./blog-payload.js";
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

  const cfg = loadConfig();
  const mongoCfg = loadMongoConfig();

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

  const restSeg = paths.wpRestPath.replace(/\/$/, "").split("/").pop() ?? "";
  if (restSeg !== "story" && restSeg !== "stories") {
    console.error(
      `[migrate-blog-stories] Warning: MIGRATION_WP_REST_PATH last segment is "${restSeg}", expected story. Proceeding anyway.`
    );
  }

  if (updateExisting) {
    console.error("[migrate-blog-stories] --update: will PUT existing Contentstack entries when UID is known.");
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
      const rel = `${restBase.replace(/^\//, "")}/${tRow.wp_id}`;
      const story = await wp.getJson<Record<string, unknown>>(rel);

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

      console.error(
        `[blog] wp_id=${tRow.wp_id} title="${cmsTitle}" url=${pageUrl} ` +
          `category=${categoryRefUid ?? "(none)"} author=${authorRefUid ?? "(none)"} ` +
          `sub_header="${pickMetaString(
            story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
              ? (story.meta as Record<string, unknown>)
              : undefined,
            metaKeys.subHeader
          )}"`
      );

      let entryUid: string;

      if (updateExisting && existingUid) {
        const updated = await cs.updateEntry(
          contentTypeUid,
          existingUid,
          entryPayload as { title: string },
          locale
        );
        entryUid = updated.uid ?? existingUid;
        trackRef.migration_message = "Updated from WordPress (--update)";
        console.error(`[blog] wp_id=${tRow.wp_id} UPDATED entry ${entryUid}`);
      } else if (updateExisting && !existingUid) {
        throw new Error(
          "No Contentstack entry UID in map or tracking; run migrate without --update first"
        );
      } else {
        const entry = await cs.createEntry(contentTypeUid, entryPayload as { title: string }, locale);
        entryUid = entry.uid;
        trackRef.migration_message = "";
        console.error(`[blog] wp_id=${tRow.wp_id} CREATED entry ${entryUid}`);
      }

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
