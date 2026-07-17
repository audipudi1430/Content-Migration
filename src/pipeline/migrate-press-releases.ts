/**
 * Migrate WordPress stories → Contentstack `press_release` (separate from blog stories).
 * - Same WP JSON shape as stories
 * - No article_image / banner_image
 * - Body is HTML RTE (not modular blocks)
 */
import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, parseUpdateFlag, type SelectionMode } from "./args.js";
import { resolveSeoMetaDescription } from "./blog-author-seo.js";
import { pickRenderedTitle } from "./blog-payload.js";
import {
  fetchWpStoryForMigration,
  loadBlogFetchBySlug,
  storySlugForFetch,
} from "./blog-story-fetch.js";
import { extractWpStorySeo } from "./blog-seo.js";
import {
  parseStorySheetColumns,
  storySheetCategoryLabels,
  storySheetHasCategoryColumns,
} from "./blog-story-sheet.js";
import {
  mappingSourceKeyWithMicrosite,
  micrositeLabel,
  resolveCmsAssetName,
  resolveExistingUidForCmsAssetName,
  usesMicrositeCmsAssetName,
} from "./cms-asset-name.js";
import { normalizeWpText } from "./contentstack-rte.js";
import { upsertContentstackEntryWithSeoFallback } from "./contentstack-entry-upsert.js";
import { buildContentstackEntryTargetUrl } from "./cs-target-url.js";
import { MigrationWarnings, mergeMigrationMessages } from "./image-size-limit.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { resolveMigrationPageUrlForRow, withMigrationPageUrl } from "./migration-url.js";
import {
  loadPressReleaseArticleCategoryContentTypeUid,
  loadPressReleaseContentTypeUid,
  loadPressReleaseDefaultLocation,
  loadPressReleaseFieldUids,
  loadPressReleaseNewsCategoryContentTypeUid,
  pressReleasePageUrlPath,
} from "./press-release-config.js";
import {
  buildPressReleaseBodyHtml,
  buildPressReleaseEntryPayload,
  pickPressReleaseSlug,
  setPressReleaseSeoGlobal,
} from "./press-release-payload.js";
import { resolveBlogCategoryUidsByNames } from "./resolve-entry-ref-by-name.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import type { TrackingRow } from "./types.js";

const MAP_SOURCE_KEY = "press_release";

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

function pickLocationFromSheet(trackRef: TrackingRow): string {
  const raw = trackRef.source_columns_json?.trim();
  if (!raw) return "";
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      const nk = k.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
      if (nk === "location" || nk === "press_location" || nk === "release_location") {
        return pickString(v);
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

export async function runMigratePressReleasesFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "PRESS_RELEASE_TRACK");
  const updateExisting = parseUpdateFlag(argv, "PRESS_RELEASE_UPDATE");
  const paths = loadPipelinePaths();
  const contentTypeUid = loadPressReleaseContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set CS_CONTENT_TYPE_PRESS_RELEASE=press_release");
  }

  const fields = loadPressReleaseFieldUids();
  const articleCategoryCt = loadPressReleaseArticleCategoryContentTypeUid();
  const newsCategoryCt = loadPressReleaseNewsCategoryContentTypeUid();
  const fetchBySlug = loadBlogFetchBySlug();

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

  if (updateExisting) {
    console.error(
      "[migrate-press-releases] --update: will PUT existing Contentstack entries when UID is known."
    );
  }

  const startSheet =
    process.env.PRESS_RELEASE_START_SHEET?.trim() || paths.migrateStartSheet;

  const allTracking = loadAllTracking(paths);
  const selected = selectContentRows(
    allTracking,
    startSheet,
    sel.mode as SelectionMode,
    sel,
    updateExisting
  );

  console.error(
    `[migrate-press-releases] sheet=${startSheet} contentType=${contentTypeUid} ` +
      `selected=${selected.length} update=${updateExisting ? "1" : "0"}`
  );

  if (selected.length === 0) {
    console.error("No press-release tracking rows selected for this sheet.");
    await closeMongo();
    return;
  }

  let ok = 0;
  let fail = 0;

  for (const tRow of selected) {
    const trackRef =
      allTracking.find(
        (r) =>
          r.wp_id === tRow.wp_id &&
          r.source_sheet === tRow.source_sheet &&
          r.url === tRow.url
      ) ?? tRow;

    const warnings = new MigrationWarnings();
    const microsite = trackRef.microsite || paths.microsite;
    const useMicrositeTitle = usesMicrositeCmsAssetName(microsite);
    const mapSourceKey = mappingSourceKeyWithMicrosite(MAP_SOURCE_KEY, microsite);

    try {
      const mapRecord = map.get("custom", tRow.wp_id, locale, mapSourceKey);
      let existingUid = resolveExistingEntryUid(mapRecord, trackRef);

      if (!updateExisting && existingUid && !useMicrositeTitle) {
        trackRef.contentstack_entry_uid = existingUid;
        trackRef.content_type_uid = contentTypeUid;
        trackRef.migration_status = "Pass";
        trackRef.migration_message =
          "Already in JSON map (use --update to refresh from WordPress)";
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
        `[press-release] wp_id=${tRow.wp_id} WP GET ${fetchUrl} ` +
          `(slug=${storySlugForFetch(trackRef) || pickPressReleaseSlug(story) || "(none)"})`
      );

      const slug = pickPressReleaseSlug(story) || String(tRow.wp_id);
      const sheetCols = parseStorySheetColumns(trackRef);
      const wpTitle =
        pickRenderedTitle(story.title) ||
        normalizeWpText(pickString(story.name)) ||
        `Press Release ${story.id ?? tRow.wp_id}`;
      const cmsTitle = wpTitle;
      const cmsAssetName = resolveCmsAssetName(cmsTitle, { locale, microsite });

      existingUid = await resolveExistingUidForCmsAssetName({
        cs,
        contentTypeUid,
        cmsAssetName,
        locale,
        microsite,
        updateExisting,
        fallbackUid: existingUid,
      });

      if (useMicrositeTitle) {
        console.error(
          `[press-release] wp_id=${tRow.wp_id} microsite=${micrositeLabel(microsite)} ` +
            `cmsAssetName="${cmsAssetName}"`
        );
      }

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

      const { path: pageUrl } = resolveMigrationPageUrlForRow(
        trackRef,
        pressReleasePageUrlPath(slug)
      );

      let articleCategoryUids: string[] = [];
      if (storySheetHasCategoryColumns(sheetCols)) {
        const labels = storySheetCategoryLabels(sheetCols);
        articleCategoryUids = await resolveBlogCategoryUidsByNames({
          names: labels,
          cs,
          categoryContentTypeUid: articleCategoryCt,
          allTracking,
          locale,
          warnings,
        });
        console.error(
          `[press-release] wp_id=${tRow.wp_id} article_category labels=${labels.join(", ") || "(none)"} ` +
            `uids=${articleCategoryUids.length}`
        );
      }

      const bodyHtml = buildPressReleaseBodyHtml(story);
      if (!bodyHtml) {
        warnings.add("body HTML empty after converting WordPress content");
      }

      const location =
        pickLocationFromSheet(trackRef) || loadPressReleaseDefaultLocation();

      const entryPayload = buildPressReleaseEntryPayload({
        story,
        fields,
        pageUrl,
        cmsTitle,
        location,
        articleCategoryUids,
        articleCategoryContentTypeUid: articleCategoryCt,
        newsCategoryContentTypeUid: newsCategoryCt,
        bodyHtml,
        locale,
        microsite,
      });

      const seo = withMigrationPageUrl(extractWpStorySeo(story, slug), pageUrl);
      const metaDescription = resolveSeoMetaDescription(cmsTitle, seo, "wp_seo");
      const existingSeo =
        existingEntry?.[fields.seoSocialGroup] &&
        typeof existingEntry[fields.seoSocialGroup] === "object" &&
        !Array.isArray(existingEntry[fields.seoSocialGroup])
          ? (existingEntry[fields.seoSocialGroup] as Record<string, unknown>)
          : undefined;

      setPressReleaseSeoGlobal(
        entryPayload,
        fields,
        seo,
        metaDescription,
        existingSeo,
        { wpId: tRow.wp_id, entity: "press-release" }
      );

      console.error(
        `[press-release] wp_id=${tRow.wp_id} url=${pageUrl} location="${location}" ` +
          `release_date=${String(entryPayload[fields.releaseDate] ?? "")} ` +
          `bodyChars=${bodyHtml.length}`
      );

      if (updateExisting && !existingUid && !useMicrositeTitle) {
        throw new Error(
          "No Contentstack entry UID in map or tracking; run migrate without --update first"
        );
      }

      const { uid: entryUid, warning: upsertWarning } =
        await upsertContentstackEntryWithSeoFallback({
          cs,
          contentTypeUid,
          payload: entryPayload as Record<string, unknown> & { title: string },
          locale,
          existingUid: updateExisting ? existingUid : undefined,
          seoFields: {
            seoSocialGroup: fields.seoSocialGroup,
            seoPageUrl: fields.seoPageUrl,
          },
          logContext: { wpId: tRow.wp_id, entity: "press-release" },
          resolveDuplicateTitle: !updateExisting && !useMicrositeTitle,
        });

      if (upsertWarning) warnings.add(upsertWarning);

      map.set({
        wpId: tRow.wp_id,
        kind: "custom",
        contentstackUid: entryUid,
        sourceKey: mapSourceKey,
        migratedAt: new Date().toISOString(),
        locale,
      });
      await map.save().catch(() => undefined);

      trackRef.contentstack_entry_uid = entryUid;
      trackRef.content_type_uid = contentTypeUid;
      trackRef.migration_status = "Pass";
      trackRef.migration_message = mergeMigrationMessages(
        updateExisting ? "Updated press_release from WordPress (--update)" : "Created press_release",
        warnings.join()
      );
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
      console.error(
        `[press-release] wp_id=${tRow.wp_id} ${updateExisting ? "UPDATED" : "CREATED"} entry ${entryUid}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      fail += 1;
      trackRef.migration_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg).catch(() => undefined);
      console.error(`[press-release] FAIL wp_id=${tRow.wp_id}: ${msg.slice(0, 220)}`);
    }
  }

  console.error(`[migrate-press-releases] Done. ok=${ok} fail=${fail}`);
  await closeMongo();
}
