import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { initPipelineEnv, parseSelection, stringArg, type SelectionMode } from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import { loadBlogContentTypeUid, loadBlogFieldUids } from "./blog-config.js";
import { fetchWpStoryForMigration, loadBlogFetchBySlug } from "./blog-story-fetch.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import { pickWpStoryDateline } from "./wp-dateline.js";

function loadConcurrency(argv: string[]): number {
  const raw =
    stringArg(argv, "--concurrency") ?? process.env.UPDATE_STORY_DATELINE_CONCURRENCY ?? "4";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 4;
}

/**
 * Re-fetch WordPress dates for already-migrated stories and update only Contentstack `dateline`
 * (Pacific wall time). Does not change body, SEO, or other fields.
 */
export async function runUpdateStoryDatelines(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const sel = parseSelection(argv, "UPDATE_STORY_DATELINE");
  // Default to updating Pass rows (already migrated).
  const mode = (sel.mode || "all") as SelectionMode;
  const paths = loadPipelinePaths();
  const contentTypeUid =
    stringArg(argv, "--content-type")?.trim() ||
    process.env.UPDATE_STORY_DATELINE_CONTENT_TYPE?.trim() ||
    loadBlogContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set CS_CONTENT_TYPE_BLOG / MIGRATION_CONTENT_TYPE_UID or --content-type=blog");
  }

  const fields = loadBlogFieldUids();
  const datelineField = fields.dateline || "dateline";
  const fetchBySlug = loadBlogFetchBySlug();
  const concurrency = loadConcurrency(argv);
  const locale =
    stringArg(argv, "--locale")?.trim() ||
    process.env.UPDATE_STORY_DATELINE_LOCALE?.trim() ||
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    "en-us";

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

  const allTracking = loadAllTracking(paths);
  // updateExisting=true → include Pass rows for already-migrated stories
  const selected = selectContentRows(
    allTracking,
    paths.migrateStartSheet,
    mode,
    sel,
    true
  ).filter((r) => Boolean(r.contentstack_entry_uid?.trim()));

  console.error(
    `[update-story-datelines] sheet=${paths.migrateStartSheet} mode=${mode} ` +
      `selected=${selected.length} contentType=${contentTypeUid} field=${datelineField} ` +
      `locale=${locale} concurrency=${concurrency} sourceTz=${process.env.BLOG_DATELINE_SOURCE_TIMEZONE || "America/Los_Angeles"}`
  );

  if (selected.length === 0) {
    console.error(
      "[update-story-datelines] No migrated story rows with contentstack_entry_uid. " +
        "Check MIGRATION_START_SHEET and tracking Pass rows."
    );
    await closeMongo();
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  await mapWithConcurrency(selected, concurrency, async (tRow) => {
    const entryUid = tRow.contentstack_entry_uid.trim();
    const trackRef =
      allTracking.find(
        (r) =>
          r.wp_id === tRow.wp_id &&
          r.source_sheet === tRow.source_sheet &&
          r.url === tRow.url
      ) ?? tRow;

    try {
      const { story } = await fetchWpStoryForMigration(
        wp,
        paths.wpRestPath,
        trackRef,
        tRow.wp_id,
        fetchBySlug
      );
      const newDateline = pickWpStoryDateline(story);
      if (!newDateline) {
        skipped += 1;
        console.error(
          `[update-story-datelines] skip wp_id=${tRow.wp_id}: no date/date_gmt on WordPress story`
        );
        return;
      }

      const existing = await cs.getEntry(contentTypeUid, entryUid, locale);
      const title = String(existing.title ?? "").trim() || "untitled";
      const previous = String(existing[datelineField] ?? "").trim();

      if (previous === newDateline) {
        skipped += 1;
        console.error(
          `[update-story-datelines] skip wp_id=${tRow.wp_id} uid=${entryUid}: already ${newDateline}`
        );
        return;
      }

      await cs.updateEntry(
        contentTypeUid,
        entryUid,
        {
          title,
          [datelineField]: newDateline,
        },
        locale
      );

      updated += 1;
      console.error(
        `[update-story-datelines] Pass wp_id=${tRow.wp_id} uid=${entryUid} ` +
          `${previous || "(none)"} → ${newDateline}`
      );

      trackRef.migration_message = `Dateline updated ${previous || "(none)"} → ${newDateline}`;
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      failed += 1;
      console.error(
        `[update-story-datelines] FAIL wp_id=${tRow.wp_id} uid=${entryUid}: ${msg.slice(0, 200)}`
      );
    }
  });

  console.error(
    `[update-story-datelines] Done. updated=${updated} skipped=${skipped} failed=${failed}`
  );
  await closeMongo();
}
