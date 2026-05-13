import type { WpEntityKind } from "../mapping-store.js";
import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { readMediaSheet, saveMediaSheet, toSheetRow } from "../media/sheet.js";
import { ensureAssetFolderUid, fetchWpMediaItem, migrateOneMediaRow } from "../media/migrate-media-core.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, type SelectionMode } from "./args.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import type { TrackingRow } from "./types.js";
import { kindFromMimeType } from "../media/mime.js";

type WpRestPost = {
  id: number;
  slug: string;
  type: string;
  title: { rendered: string };
  content?: { rendered: string };
  featured_media?: number;
};

export function wpEntityKindFromRestPath(restPath: string): WpEntityKind {
  const seg = restPath.replace(/\/$/, "").split("/").pop() ?? "";
  if (seg === "posts") return "post";
  if (seg === "pages") return "page";
  return "custom";
}

function selectMediaTrackingRows(
  rows: TrackingRow[],
  mode: SelectionMode,
  opts: { singleId?: number; ids: number[]; offset: number; limit: number }
): TrackingRow[] {
  let selected = rows.filter((r) => r.migration_status !== "NoWpId" && r.wp_id > 0);
  if (mode === "single") {
    if (!opts.singleId) throw new Error("single mode requires --single-id=<wp_id>");
    selected = selected.filter((r) => r.wp_id === opts.singleId);
  } else if (mode === "ids") {
    if (opts.ids.length === 0) throw new Error("ids mode requires --ids=1,2,3");
    const set = new Set(opts.ids);
    selected = selected.filter((r) => set.has(r.wp_id));
  } else if (mode === "failed") {
    selected = selected.filter((r) => r.migration_status === "Fail");
  }
  return selected.slice(opts.offset, opts.offset + opts.limit);
}

export async function runMigrateMediaFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "MEDIA_TRACK");
  const paths = loadPipelinePaths();
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

  const allTracking = loadAllTracking(paths);
  const candidates = allTracking.filter(
    (r) => r.row_kind === "media" && r.source_sheet === paths.mediaTabName
  );
  const selected = selectMediaTrackingRows(candidates, sel.mode as SelectionMode, sel);

  if (selected.length === 0) {
    console.error("No media tracking rows selected.");
    await closeMongo();
    return;
  }

  let mediaRows = readMediaSheet(mediaSheetPath);
  let completed = 0;

  for (const tRow of selected) {
    const trackRef = allTracking.find(
      (r) => r.row_kind === "media" && r.wp_id === tRow.wp_id && r.source_sheet === tRow.source_sheet && r.url === tRow.url
    );
    if (!trackRef) continue;
    let mRow = mediaRows.find((m) => m.wp_id === tRow.wp_id);
    try {
      if (!mRow) {
        const item = await fetchWpMediaItem(wp, tRow.wp_id);
        mRow = toSheetRow(item);
        mediaRows.push(mRow);
        saveMediaSheet(mediaSheetPath, mediaRows);
      }
      if (mRow.migration_status === "Pass" && mRow.contentstack_uid) {
        trackRef.migration_status = "Pass";
        trackRef.contentstack_asset_uid =
          mRow.contentstack_type === "asset" ? mRow.contentstack_uid : trackRef.contentstack_asset_uid;
        trackRef.contentstack_entry_uid =
          mRow.contentstack_type !== "asset" ? mRow.contentstack_uid : trackRef.contentstack_entry_uid;
        trackRef.migration_message = "Already migrated in media sheet";
        trackRef.updated_at = new Date().toISOString();
        await persistOneRow(paths, allTracking, trackRef, mongoCfg);
        completed += 1;
        continue;
      }
      const result = await migrateOneMediaRow(mRow, wp, cs, map, folderUid, locale);
      mRow.migration_status = "Pass";
      mRow.contentstack_uid = result.uid;
      mRow.contentstack_type = result.type;
      mRow.migration_message = "";
      mRow.migrated_at = new Date().toISOString();
      saveMediaSheet(mediaSheetPath, mediaRows);
      await map.save();

      trackRef.migration_status = "Pass";
      trackRef.contentstack_asset_uid = result.type === "asset" ? result.uid : "";
      trackRef.contentstack_entry_uid = result.type !== "asset" ? result.uid : "";
      trackRef.migration_message = "";
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      completed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      trackRef.migration_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.updated_at = new Date().toISOString();
      if (mRow) {
        mRow.migration_status = "Fail";
        mRow.migration_message = msg;
        mRow.migrated_at = new Date().toISOString();
        saveMediaSheet(mediaSheetPath, mediaRows);
      }
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      console.error(`[media] wp_id=${tRow.wp_id} FAIL: ${msg}`);
    }
  }

  await closeMongo();
  console.error(`[migrate-media] Done. ${completed}/${selected.length} succeeded (selection size).`);
}

async function ensureFeaturedAssetUid(
  attachmentId: number,
  wp: WordPressClient,
  cs: ContentstackManagementClient,
  map: MappingStore,
  mediaSheetPath: string,
  folderUid: string,
  locale: string | undefined
): Promise<string> {
  const mapped = map.get("asset", attachmentId);
  if (mapped?.assetUid) return mapped.assetUid;

  let mediaRows = readMediaSheet(mediaSheetPath);
  let mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (mRow?.migration_status === "Pass" && mRow.contentstack_type === "asset" && mRow.contentstack_uid) {
    map.set({
      wpId: attachmentId,
      kind: "asset",
      assetUid: mRow.contentstack_uid,
      sourceKey: mRow.wp_slug,
      migratedAt: new Date().toISOString(),
      locale,
    });
    return mRow.contentstack_uid;
  }

  const item = await fetchWpMediaItem(wp, attachmentId);
  if (kindFromMimeType(item.mime_type) !== "image") {
    throw new Error(
      `Featured media ${attachmentId} is not an image (${item.mime_type}); map as asset or adjust WordPress.`
    );
  }
  if (!mRow) {
    mRow = toSheetRow(item);
    mediaRows.push(mRow);
  }
  const result = await migrateOneMediaRow(mRow, wp, cs, map, folderUid, locale);
  mRow.migration_status = "Pass";
  mRow.contentstack_uid = result.uid;
  mRow.contentstack_type = result.type;
  mRow.migrated_at = new Date().toISOString();
  saveMediaSheet(mediaSheetPath, mediaRows);
  await map.save();
  if (result.type !== "asset") {
    throw new Error(`Featured media ${attachmentId} resolved to ${result.type}, expected asset`);
  }
  return result.uid;
}

function selectContentRows(
  rows: TrackingRow[],
  sheet: string,
  mode: SelectionMode,
  opts: { singleId?: number; ids: number[]; offset: number; limit: number }
): TrackingRow[] {
  let selected = rows.filter(
    (r) => r.row_kind === "content" && r.source_sheet === sheet && r.migration_status !== "NoWpId" && r.wp_id > 0
  );
  if (mode === "single") {
    if (!opts.singleId) throw new Error("single mode requires --single-id=<wp_id>");
    selected = selected.filter((r) => r.wp_id === opts.singleId);
  } else if (mode === "ids") {
    if (opts.ids.length === 0) throw new Error("ids mode requires --ids=1,2,3");
    const set = new Set(opts.ids);
    selected = selected.filter((r) => set.has(r.wp_id));
  } else if (mode === "failed") {
    selected = selected.filter((r) => r.migration_status === "Fail");
  } else {
    selected = selected.filter((r) => r.migration_status === "Pending" || r.migration_status === "Fail");
  }
  return selected.slice(opts.offset, opts.offset + opts.limit);
}

export async function runMigrateContentFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "CONTENT_TRACK");
  const paths = loadPipelinePaths();
  if (!paths.contentTypeUid) {
    throw new Error("Set MIGRATION_CONTENT_TYPE_UID or CS_CONTENT_TYPE_POST for content migration");
  }
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
  const kind = wpEntityKindFromRestPath(paths.wpRestPath);

  const allTracking = loadAllTracking(paths);
  const selected = selectContentRows(allTracking, paths.migrateStartSheet, sel.mode as SelectionMode, sel);

  if (selected.length === 0) {
    console.error("No content tracking rows selected.");
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
      const existing = map.get(kind, tRow.wp_id, locale);
      if (existing?.contentstackUid) {
        trackRef.contentstack_entry_uid = existing.contentstackUid;
        trackRef.migration_status = "Pass";
        trackRef.migration_message = "Already in JSON map";
        trackRef.updated_at = new Date().toISOString();
        await persistOneRow(paths, allTracking, trackRef, mongoCfg);
        ok += 1;
        continue;
      }

      const rel = `${paths.wpRestPath.replace(/^\//, "")}/${tRow.wp_id}`;
      const p = await wp.getJson<WpRestPost>(rel);
      const featured = p.featured_media && p.featured_media > 0 ? p.featured_media : undefined;
      const entryPayload: Record<string, unknown> = {
        title: p.title?.rendered ?? `wp-${tRow.wp_id}`,
        url_slug: p.slug ?? String(tRow.wp_id),
        body: p.content?.rendered ?? "",
      };
      if (featured && paths.featuredImageFieldUid) {
        const assetUid = await ensureFeaturedAssetUid(featured, wp, cs, map, mediaSheetPath, folderUid, locale);
        entryPayload[paths.featuredImageFieldUid] = [{ uid: assetUid }];
      }
      if (featured) {
        trackRef.featured_media_wp_id = String(featured);
      }

      const entry = await cs.createEntry(paths.contentTypeUid, entryPayload as { title: string }, locale);
      map.set({
        wpId: tRow.wp_id,
        kind,
        contentstackUid: entry.uid,
        sourceKey: p.slug,
        migratedAt: new Date().toISOString(),
        locale,
      });
      await map.save();

      trackRef.contentstack_entry_uid = entry.uid;
      trackRef.content_type_uid = paths.contentTypeUid;
      trackRef.migration_status = "Pass";
      trackRef.migration_message = "";
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      trackRef.migration_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      console.error(`[content] wp_id=${tRow.wp_id} FAIL: ${msg}`);
    }
  }

  await closeMongo();
  console.error(`[migrate-content] Finished. ${ok}/${selected.length} OK for sheet "${paths.migrateStartSheet}".`);
}
