import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { readMediaSheet, saveMediaSheet, toSheetRow } from "../media/sheet.js";
import { fetchWpMediaItem, migrateOneMediaRow } from "../media/migrate-media-core.js";
import { kindFromMimeType } from "../media/mime.js";
import {
  csAssetFileSizeBytes,
  exceedsImageSizeLimit,
  formatFileSizeBytes,
  loadMigrationImageMaxBytes,
} from "./image-size-limit.js";

/**
 * Ensure a WordPress media attachment exists as a Contentstack **image** asset UID.
 * Uses migration map + media sheet; migrates on demand if missing.
 */
export async function ensureWpAttachmentImageAssetUid(
  attachmentId: number,
  wp: WordPressClient,
  cs: ContentstackManagementClient,
  map: MappingStore,
  mediaSheetPath: string,
  folderUid: string,
  locale: string | undefined,
  purpose: string
): Promise<string> {
  const max = loadMigrationImageMaxBytes();
  const mapped = map.get("asset", attachmentId);
  if (mapped?.assetUid && (await cs.assetExists(mapped.assetUid))) {
    const csSize = await csAssetFileSizeBytes(cs, mapped.assetUid);
    if (csSize === undefined || !exceedsImageSizeLimit(csSize, max)) {
      return mapped.assetUid;
    }
    console.error(
      `[asset] wp_id=${attachmentId} map uid=${mapped.assetUid} ${csSize !== undefined ? formatFileSizeBytes(csSize) : "size unknown"} exceeds ${formatFileSizeBytes(max)}; re-migrating (${purpose})`
    );
  } else if (mapped?.assetUid) {
    console.error(
      `[asset] wp_id=${attachmentId} map uid=${mapped.assetUid} not in this stack; re-migrating (${purpose})`
    );
  }

  let mediaRows = readMediaSheet(mediaSheetPath);
  let mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (mRow?.migration_status === "Pass" && mRow.contentstack_type === "asset" && mRow.contentstack_uid) {
    if (await cs.assetExists(mRow.contentstack_uid)) {
      const csSize = await csAssetFileSizeBytes(cs, mRow.contentstack_uid);
      if (csSize === undefined || !exceedsImageSizeLimit(csSize, max)) {
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
      console.error(
        `[asset] wp_id=${attachmentId} sheet uid=${mRow.contentstack_uid} oversized; re-migrating (${purpose})`
      );
    } else {
      console.error(
        `[asset] wp_id=${attachmentId} sheet uid=${mRow.contentstack_uid} not in this stack; re-migrating (${purpose})`
      );
    }
  }

  const item = await fetchWpMediaItem(wp, attachmentId);
  if (kindFromMimeType(item.mime_type) !== "image") {
    throw new Error(
      `${purpose}: attachment ${attachmentId} is not an image (${item.mime_type}); cannot map to image asset.`
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
    throw new Error(`${purpose}: attachment ${attachmentId} resolved to ${result.type}, expected asset`);
  }
  return result.uid;
}
