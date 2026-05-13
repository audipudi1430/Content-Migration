import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseIdsCsv, stringArg, numberArg } from "./args.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import type { TrackingRow } from "./types.js";

function parseUidCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export async function runPublishFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const paths = loadPipelinePaths();
  const cfg = loadConfig();
  const mongoCfg = loadMongoConfig();
  const locale = process.env.CONTENTSTACK_LOCALE;

  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });

  const publishMode =
    stringArg(argv, "--publish-mode") ?? process.env.PUBLISH_MODE ?? "bulk-status";
  const migrationStatusFilter =
    stringArg(argv, "--filter-migration-status") ?? process.env.PUBLISH_FILTER_MIGRATION_STATUS ?? "Pass";
  const publishStatusFilter =
    stringArg(argv, "--filter-publish-status") ?? process.env.PUBLISH_FILTER_PUBLISH_STATUS ?? "Unpublished";

  const wpIdsArg = parseIdsCsv(stringArg(argv, "--wp-ids") ?? process.env.PUBLISH_WP_IDS);
  const csUidsArg = parseUidCsv(stringArg(argv, "--cs-uids") ?? process.env.PUBLISH_CS_UIDS);
  const limit = numberArg(argv, "--limit") ?? (Number(process.env.PUBLISH_LIMIT ?? "500") || 500);

  const all = loadAllTracking(paths);
  let targets: TrackingRow[] = [];

  if (publishMode === "bulk-status" || publishMode === "bulk") {
    targets = all.filter(
      (r) =>
        r.row_kind === "content" &&
        r.migration_status === migrationStatusFilter &&
        r.publish_status === publishStatusFilter &&
        Boolean(r.contentstack_entry_uid)
    );
  } else if (publishMode === "wp-ids") {
    if (wpIdsArg.length === 0) {
      throw new Error("publish-mode=wp-ids requires --wp-ids=1,2 or PUBLISH_WP_IDS");
    }
    const set = new Set(wpIdsArg);
    targets = all.filter((r) => set.has(r.wp_id) && Boolean(r.contentstack_entry_uid));
  } else if (publishMode === "cs-uids") {
    if (csUidsArg.length === 0) {
      throw new Error("publish-mode=cs-uids requires --cs-uids=uid1,uid2 or PUBLISH_CS_UIDS");
    }
    const set = new Set(csUidsArg);
    targets = all.filter((r) => r.contentstack_entry_uid && set.has(r.contentstack_entry_uid));
  } else {
    throw new Error(`Unknown --publish-mode=${publishMode} (bulk-status|wp-ids|cs-uids)`);
  }

  targets = targets.slice(0, Math.max(1, limit));

  if (targets.length === 0) {
    console.error("No entries matched publish selection.");
    await closeMongo();
    return;
  }

  let ok = 0;
  for (const row of targets) {
    const ctUid = row.content_type_uid || paths.contentTypeUid;
    if (!ctUid || !row.contentstack_entry_uid) {
      console.error(`[publish] skip wp_id=${row.wp_id}: missing content type or entry uid`);
      continue;
    }
    const trackRef = all.find(
      (r) =>
        r.row_kind === row.row_kind &&
        r.source_sheet === row.source_sheet &&
        r.wp_id === row.wp_id &&
        r.url === row.url
    );
    if (!trackRef) continue;

    try {
      const entry = await cs.getEntry(ctUid, row.contentstack_entry_uid, locale);
      const version = typeof entry.version === "number" ? entry.version : undefined;
      await cs.publishEntry(ctUid, row.contentstack_entry_uid, {
        environments: paths.publishEnvironments,
        locales: paths.publishLocales,
        localeQuery: locale ? `?locale=${encodeURIComponent(locale)}` : undefined,
        version,
      });
      trackRef.publish_status = "Published";
      trackRef.published_at = new Date().toISOString();
      trackRef.migration_message = "";
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, all, trackRef, mongoCfg);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      trackRef.publish_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, all, trackRef, mongoCfg);
      console.error(`[publish] wp_id=${row.wp_id} uid=${row.contentstack_entry_uid} FAIL: ${msg}`);
    }
  }

  await closeMongo();
  console.error(`[publish] Completed ${ok}/${targets.length} publish attempts.`);
}
