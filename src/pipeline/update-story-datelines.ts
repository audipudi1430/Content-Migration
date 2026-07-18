import { loadConfig } from "../config.js";
import {
  loadMongoConfig,
  loadPipelinePaths,
  wpRestPathForSourceTab,
} from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { initPipelineEnv, numberArg, parseSelection, stringArg, type SelectionMode } from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import { loadBlogContentTypeUid, loadBlogFieldUids } from "./blog-config.js";
import {
  fetchWpStoryBySlug,
  fetchWpStoryForMigration,
  storySlugForFetch,
} from "./blog-story-fetch.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { normalizeMigrationUrlPath } from "./migration-url.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import {
  defaultStoryDatelineWorkbookPath,
  readStoryDatelineWorkbook,
  storyDatelineStatusWorkbookPath,
  writeStoryDatelineStatusWorkbook,
  type StoryDatelineSheetRow,
} from "./update-story-datelines-sheet.js";
import { collectSlugCandidates } from "./wp-extract-enrich.js";
import { pickWpStoryDateline } from "./wp-dateline.js";

function loadConcurrency(argv: string[]): number {
  const raw =
    stringArg(argv, "--concurrency") ?? process.env.UPDATE_STORY_DATELINE_CONCURRENCY ?? "4";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 4;
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

async function fetchWpStoryFromPublicUrl(
  wp: WordPressClient,
  restBase: string,
  wpUrl: string
): Promise<{ story: Record<string, unknown>; fetchUrl: string; wpId: number }> {
  const base = restBase.replace(/^\//, "").replace(/\/$/, "");
  const candidates = collectSlugCandidates(wpUrl, "content");
  if (candidates.length === 0) {
    throw new Error(`Could not derive WordPress slug from url=${wpUrl}`);
  }

  let lastErr: unknown;
  for (const slug of candidates) {
    try {
      const story = await fetchWpStoryBySlug(wp, base, slug);
      const wpId = typeof story.id === "number" ? story.id : Number(story.id) || 0;
      return {
        story: story as Record<string, unknown>,
        fetchUrl: `${base}?slug=${encodeURIComponent(slug)}`,
        wpId,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `WordPress story not found for url=${wpUrl} (tried slugs: ${candidates.join(", ")}): ${msg}`
  );
}

async function updateDatelineOnEntry(opts: {
  cs: ContentstackManagementClient;
  contentTypeUid: string;
  entryUid: string;
  datelineField: string;
  locale: string;
  newDateline: string;
}): Promise<{ previous: string; skipped: boolean }> {
  const existing = await opts.cs.getEntry(
    opts.contentTypeUid,
    opts.entryUid,
    opts.locale
  );
  const title = String(existing.title ?? "").trim() || "untitled";
  const previous = String(existing[opts.datelineField] ?? "").trim();
  if (previous === opts.newDateline) {
    return { previous, skipped: true };
  }
  await opts.cs.updateEntry(
    opts.contentTypeUid,
    opts.entryUid,
    {
      title,
      [opts.datelineField]: opts.newDateline,
    },
    opts.locale
  );
  return { previous, skipped: false };
}

/**
 * Workbook mode: Excel columns `url` (WordPress) + `new_url` (Contentstack path).
 * Find CS entry by new_url, fetch date from WP REST via url, update dateline only.
 */
async function runUpdateStoryDatelinesFromWorkbook(
  argv: string[],
  opts: {
    workbookPath: string;
    contentTypeUid: string;
    datelineField: string;
    locale: string;
    concurrency: number;
    urlField: string;
  }
): Promise<void> {
  const tabName = stringArg(argv, "--tab")?.trim() || process.env.UPDATE_STORY_DATELINE_TAB?.trim();
  const skipPass = !argv.includes("--no-skip-pass");
  const limit = numberArg(argv, "--limit");
  const paths = loadPipelinePaths();
  const cfg = loadConfig();

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

  let rows = readStoryDatelineWorkbook(opts.workbookPath, tabName);
  if (limit != null && limit > 0) rows = rows.slice(0, limit);

  const restBase = (
    process.env.UPDATE_STORY_DATELINE_WP_REST_PATH?.trim() ||
    wpRestPathForSourceTab(paths, paths.migrateStartSheet, "content") ||
    paths.wpRestPath
  ).replace(/\/$/, "");

  console.error(
    `[update-story-datelines] workbook=${opts.workbookPath} tab=${tabName || "(first)"} ` +
      `rows=${rows.length} contentType=${opts.contentTypeUid} field=${opts.datelineField} ` +
      `wpRest=${restBase} locale=${opts.locale} concurrency=${opts.concurrency}`
  );

  if (rows.length === 0) {
    console.error("[update-story-datelines] No workbook rows (need url and/or new_url).");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(() => {
      writeStoryDatelineStatusWorkbook(opts.workbookPath, rows);
    });
    return writeChain;
  };

  await mapWithConcurrency(rows, opts.concurrency, async (row, index) => {
    const now = new Date().toISOString();

    if (skipPass && row.update_status === "Pass") {
      skipped += 1;
      console.error(`[update-story-datelines] skip (already Pass): new_url=${row.new_url || row.url}`);
      return;
    }

    try {
      if (!row.new_url.trim()) {
        throw new Error("Missing new_url (Contentstack entry url path)");
      }
      if (!row.url.trim()) {
        throw new Error("Missing url (WordPress public URL for date fetch)");
      }

      let entryUid = row.contentstack_entry_uid.trim();
      if (!entryUid) {
        const candidates = urlLookupCandidates(row.new_url);
        const matches = await cs.findEntryUidsByExactUrl(
          opts.contentTypeUid,
          candidates,
          opts.locale,
          opts.urlField
        );
        if (matches.length === 0) {
          throw new Error(
            `No Contentstack entry for new_url candidates: ${candidates.join(", ")}`
          );
        }
        entryUid = matches[0]!;
        if (matches.length > 1) {
          console.error(
            `[update-story-datelines] WARNING: ${matches.length} entries matched new_url; using ${entryUid}`
          );
        }
      }

      const { story, fetchUrl, wpId } = await fetchWpStoryFromPublicUrl(
        wp,
        restBase,
        row.url
      );
      console.error(
        `[update-story-datelines] new_url=${row.new_url} uid=${entryUid} WP ${fetchUrl}`
      );

      const newDateline = pickWpStoryDateline(story);
      if (!newDateline) {
        row.update_status = "Skipped";
        row.update_message = "No date/date_gmt on WordPress story";
        row.updated_at = now;
        row.contentstack_entry_uid = entryUid;
        row.wp_id = wpId;
        skipped += 1;
        rows[index] = row;
        await persist();
        return;
      }

      const { previous, skipped: already } = await updateDatelineOnEntry({
        cs,
        contentTypeUid: opts.contentTypeUid,
        entryUid,
        datelineField: opts.datelineField,
        locale: opts.locale,
        newDateline,
      });

      row.contentstack_entry_uid = entryUid;
      row.wp_id = wpId;
      row.previous_dateline = previous;
      row.new_dateline = newDateline;
      row.updated_at = now;

      if (already) {
        row.update_status = "Skipped";
        row.update_message = `already ${newDateline}`;
        skipped += 1;
        console.error(
          `[update-story-datelines] skip uid=${entryUid}: already ${newDateline}`
        );
      } else {
        row.update_status = "Pass";
        row.update_message = `${previous || "(none)"} → ${newDateline}`;
        updated += 1;
        console.error(
          `[update-story-datelines] Pass uid=${entryUid} ${previous || "(none)"} → ${newDateline}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      row.update_status = "Fail";
      row.update_message = msg;
      row.updated_at = now;
      failed += 1;
      console.error(
        `[update-story-datelines] FAIL new_url=${row.new_url || "(none)"}: ${msg.slice(0, 220)}`
      );
    } finally {
      rows[index] = row;
      await persist();
    }
  });

  await persist();
  console.error(
    `[update-story-datelines] Done (workbook). updated=${updated} skipped=${skipped} failed=${failed} ` +
      `status=${storyDatelineStatusWorkbookPath(opts.workbookPath)}`
  );
}

/**
 * Re-fetch WordPress dates for already-migrated stories and update only Contentstack `dateline`.
 *
 * Modes:
 * 1) Tracking (default): Pass rows with contentstack_entry_uid from migration tracking
 * 2) Workbook: `--workbook=file.xlsx` with columns `url` (WP) + `new_url` (CS path)
 */
export async function runUpdateStoryDatelines(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const contentTypeUid =
    stringArg(argv, "--content-type")?.trim() ||
    process.env.UPDATE_STORY_DATELINE_CONTENT_TYPE?.trim() ||
    loadBlogContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set CS_CONTENT_TYPE_BLOG / MIGRATION_CONTENT_TYPE_UID or --content-type=blog");
  }

  const fields = loadBlogFieldUids();
  const datelineField = fields.dateline || "dateline";
  const concurrency = loadConcurrency(argv);
  const locale =
    stringArg(argv, "--locale")?.trim() ||
    process.env.UPDATE_STORY_DATELINE_LOCALE?.trim() ||
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    "en-us";

  const workbookArg =
    stringArg(argv, "--workbook")?.trim() ||
    process.env.UPDATE_STORY_DATELINE_WORKBOOK?.trim();

  if (workbookArg) {
    const workbookPath = defaultStoryDatelineWorkbookPath(workbookArg);
    await runUpdateStoryDatelinesFromWorkbook(argv, {
      workbookPath,
      contentTypeUid,
      datelineField,
      locale,
      concurrency,
      urlField: fields.url || "url",
    });
    return;
  }

  const sel = parseSelection(argv, "UPDATE_STORY_DATELINE");
  const mode = (sel.mode || "all") as SelectionMode;
  // parseSelection defaults limit=25; for mode=all process every row unless --limit / LIMIT is set.
  const explicitLimit =
    numberArg(argv, "--limit") ??
    (process.env.UPDATE_STORY_DATELINE_LIMIT?.trim()
      ? Number(process.env.UPDATE_STORY_DATELINE_LIMIT)
      : undefined);
  const selection =
    mode === "all" && (explicitLimit == null || !Number.isFinite(explicitLimit))
      ? { ...sel, limit: Number.MAX_SAFE_INTEGER }
      : sel;
  const paths = loadPipelinePaths();

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
  const selected = selectContentRows(
    allTracking,
    paths.migrateStartSheet,
    mode,
    selection,
    true
  ).filter((r) => Boolean(r.contentstack_entry_uid?.trim()));

  console.error(
    `[update-story-datelines] sheet=${paths.migrateStartSheet} mode=${mode} ` +
      `selected=${selected.length}` +
      (explicitLimit != null ? ` limit=${explicitLimit}` : mode === "all" ? " limit=all" : "") +
      ` contentType=${contentTypeUid} field=${datelineField} ` +
      `locale=${locale} concurrency=${concurrency}`
  );

  if (selected.length === 0) {
    console.error(
      "[update-story-datelines] No migrated story rows with contentstack_entry_uid. " +
        "Or pass --workbook=file.xlsx with columns url + new_url."
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
      const restBase = (
        trackRef.wp_rest_path?.trim() ||
        wpRestPathForSourceTab(paths, trackRef.source_sheet, "content") ||
        paths.wpRestPath
      ).replace(/\/$/, "");

      const { story, fetchUrl } = await fetchWpStoryForMigration(
        wp,
        restBase,
        trackRef,
        tRow.wp_id,
        false
      );
      console.error(
        `[update-story-datelines] wp_id=${tRow.wp_id} fetched ${fetchUrl} ` +
          `(slug=${storySlugForFetch(trackRef) || "(n/a)"})`
      );
      const newDateline = pickWpStoryDateline(story);
      if (!newDateline) {
        skipped += 1;
        console.error(
          `[update-story-datelines] skip wp_id=${tRow.wp_id}: no date/date_gmt on WordPress story`
        );
        return;
      }

      const { previous, skipped: already } = await updateDatelineOnEntry({
        cs,
        contentTypeUid,
        entryUid,
        datelineField,
        locale,
        newDateline,
      });

      if (already) {
        skipped += 1;
        console.error(
          `[update-story-datelines] skip wp_id=${tRow.wp_id} uid=${entryUid}: already ${newDateline}`
        );
        return;
      }

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
