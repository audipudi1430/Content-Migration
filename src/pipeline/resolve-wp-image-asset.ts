import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { readMediaSheet } from "../media/sheet.js";
import { ensureWpAttachmentImageAssetUid } from "./wp-media-asset.js";
import type { TrackingRow } from "./types.js";

export type ResolveAssetSource = "map" | "media_sheet" | "tracking" | "migrated_on_demand";

export type ResolvedWpImageAsset = {
  assetUid: string;
  source: ResolveAssetSource;
};

/**
 * Look up a migrated Contentstack asset UID for a WordPress media attachment id.
 * Order: migration map → wp-media-mapping sheet → media_urls tracking tab → migrate on demand.
 */
export async function resolveWpImageAssetUid(opts: {
  attachmentId: number;
  wp: WordPressClient;
  cs: ContentstackManagementClient;
  map: MappingStore;
  mediaSheetPath: string;
  folderUid: string;
  locale: string | undefined;
  purpose: string;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
}): Promise<ResolvedWpImageAsset> {
  const { attachmentId } = opts;
  if (attachmentId <= 0) {
    throw new Error(`${opts.purpose}: invalid attachment id ${attachmentId}`);
  }

  const mapped = opts.map.get("asset", attachmentId, opts.locale);
  if (mapped?.assetUid) {
    return { assetUid: mapped.assetUid, source: "map" };
  }

  const mediaRows = readMediaSheet(opts.mediaSheetPath);
  const mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (mRow?.migration_status === "Pass" && mRow.contentstack_type === "asset" && mRow.contentstack_uid) {
    opts.map.set({
      wpId: attachmentId,
      kind: "asset",
      assetUid: mRow.contentstack_uid,
      sourceKey: mRow.wp_slug,
      migratedAt: new Date().toISOString(),
      locale: opts.locale,
    });
    return { assetUid: mRow.contentstack_uid, source: "media_sheet" };
  }

  const mediaTab = opts.paths.mediaTabName;
  const trackHit = opts.allTracking.find(
    (r) =>
      r.row_kind === "media" &&
      r.wp_id === attachmentId &&
      r.source_sheet === mediaTab &&
      r.migration_status === "Pass" &&
      Boolean(r.contentstack_asset_uid)
  );
  if (trackHit?.contentstack_asset_uid) {
    opts.map.set({
      wpId: attachmentId,
      kind: "asset",
      assetUid: trackHit.contentstack_asset_uid,
      sourceKey: trackHit.wp_slug || String(attachmentId),
      migratedAt: new Date().toISOString(),
      locale: opts.locale,
    });
    return { assetUid: trackHit.contentstack_asset_uid, source: "tracking" };
  }

  const uid = await ensureWpAttachmentImageAssetUid(
    attachmentId,
    opts.wp,
    opts.cs,
    opts.map,
    opts.mediaSheetPath,
    opts.folderUid,
    opts.locale,
    opts.purpose
  );
  return { assetUid: uid, source: "migrated_on_demand" };
}
