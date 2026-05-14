import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { readMediaSheet, saveMediaSheet, toSheetRow } from "../media/sheet.js";
import { fetchWpMediaItem, migrateOneMediaRow } from "../media/migrate-media-core.js";
import { kindFromMimeType } from "../media/mime.js";

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
