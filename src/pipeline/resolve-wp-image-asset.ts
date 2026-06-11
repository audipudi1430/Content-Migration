import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import type { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { readMediaSheet } from "../media/sheet.js";
import { ensureWpAttachmentImageAssetUid } from "./wp-media-asset.js";
import type { TrackingRow } from "./types.js";

export type ResolveAssetSource = "map" | "media_sheet" | "tracking" | "migrated_on_demand";

export type ResolvedWpImageAsset = {
  assetUid: string;
  source: ResolveAssetSource;
};

async function assetUidInStack(
  cs: ContentstackManagementClient,
  assetUid: string
): Promise<boolean> {
  try {
    return await cs.assetExists(assetUid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[asset] verify uid=${assetUid} FAIL: ${msg.slice(0, 200)}`);
    return false;
  }
}

/**
 * Look up a migrated Contentstack asset UID for a WordPress media attachment id.
 * Order: migration map → wp-media-mapping sheet → media_urls tracking tab → migrate on demand.
 * Mapped UIDs are verified against the current stack (stack-b rejects stack-a asset UIDs).
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
    if (await assetUidInStack(opts.cs, mapped.assetUid)) {
      return { assetUid: mapped.assetUid, source: "map" };
    }
    console.error(
      `[asset] wp_id=${attachmentId} map uid=${mapped.assetUid} not in this stack; re-migrating (${opts.purpose})`
    );
  }

  const mediaRows = readMediaSheet(opts.mediaSheetPath);
  const mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (mRow?.migration_status === "Pass" && mRow.contentstack_type === "asset" && mRow.contentstack_uid) {
    if (await assetUidInStack(opts.cs, mRow.contentstack_uid)) {
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
    console.error(
      `[asset] wp_id=${attachmentId} sheet uid=${mRow.contentstack_uid} not in this stack; re-migrating (${opts.purpose})`
    );
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
    if (await assetUidInStack(opts.cs, trackHit.contentstack_asset_uid)) {
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
    console.error(
      `[asset] wp_id=${attachmentId} tracking uid=${trackHit.contentstack_asset_uid} not in this stack; re-migrating (${opts.purpose})`
    );
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
