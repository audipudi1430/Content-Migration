import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { readMediaSheet, saveMediaSheet, toSheetRow } from "../media/sheet.js";
import { fetchWpMediaItem, migrateOneMediaRow } from "../media/migrate-media-core.js";
import { kindFromMimeType } from "../media/mime.js";
import {
  exceedsImageSizeLimit,
  formatFileSizeBytes,
  loadMigrationImageMaxBytes,
  wpAttachmentFileSizeBytes,
} from "./image-size-limit.js";
import {
  loadMigrationImageAutoReduce,
  prepareWpImageBufferUnderLimit,
  wpMediaTitle,
} from "./reduce-image-for-limit.js";

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
  if (mapped?.assetUid && (await cs.assetExists(mapped.assetUid))) {
    return mapped.assetUid;
  }
  if (mapped?.assetUid) {
    console.error(
      `[asset] wp_id=${attachmentId} map uid=${mapped.assetUid} not in this stack; re-migrating (${purpose})`
    );
  }

  let mediaRows = readMediaSheet(mediaSheetPath);
  let mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (mRow?.migration_status === "Pass" && mRow.contentstack_type === "asset" && mRow.contentstack_uid) {
    if (await cs.assetExists(mRow.contentstack_uid)) {
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
      `[asset] wp_id=${attachmentId} sheet uid=${mRow.contentstack_uid} not in this stack; re-migrating (${purpose})`
    );
  }

  const item = await fetchWpMediaItem(wp, attachmentId);
  if (kindFromMimeType(item.mime_type) !== "image") {
    throw new Error(
      `${purpose}: attachment ${attachmentId} is not an image (${item.mime_type}); cannot map to image asset.`
    );
  }

  if (loadMigrationImageAutoReduce()) {
    const wpSize = await wpAttachmentFileSizeBytes(wp, attachmentId);
    if (wpSize !== undefined && exceedsImageSizeLimit(wpSize, loadMigrationImageMaxBytes())) {
      return ensureWpAttachmentReducedImageAssetUid(
        attachmentId,
        wp,
        cs,
        map,
        mediaSheetPath,
        folderUid,
        locale,
        purpose
      );
    }
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

/**
 * Upload a WordPress attachment as a Contentstack image asset, reducing size when needed
 * so the file fits under `MIGRATION_IMAGE_MAX_BYTES` (for article_image, seo.meta_image, etc.).
 */
export async function ensureWpAttachmentReducedImageAssetUid(
  attachmentId: number,
  wp: WordPressClient,
  cs: ContentstackManagementClient,
  map: MappingStore,
  mediaSheetPath: string,
  folderUid: string,
  locale: string | undefined,
  purpose: string
): Promise<string> {
  const item = await fetchWpMediaItem(wp, attachmentId);
  if (kindFromMimeType(item.mime_type) !== "image") {
    throw new Error(
      `${purpose}: attachment ${attachmentId} is not an image (${item.mime_type}); cannot map to image asset.`
    );
  }

  const prepared = await prepareWpImageBufferUnderLimit(wp, item);
  if (prepared.reduced || prepared.finalBytes < prepared.originalBytes) {
    console.error(
      `[asset] wp_id=${attachmentId} reduced ${formatFileSizeBytes(prepared.originalBytes)} → ` +
        `${formatFileSizeBytes(prepared.finalBytes)} (${purpose}) variant=${prepared.fromVariant}`
    );
  }

  const uploaded = await cs.uploadAssetFile({
    buffer: prepared.buffer,
    filename: prepared.filename,
    contentType: prepared.contentType,
    title: wpMediaTitle(item),
    parentFolderUid: folderUid,
  });

  let mediaRows = readMediaSheet(mediaSheetPath);
  let mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (!mRow) {
    mRow = toSheetRow(item);
    mediaRows.push(mRow);
  }
  mRow.migration_status = "Pass";
  mRow.contentstack_uid = uploaded.uid;
  mRow.contentstack_type = "asset";
  mRow.migrated_at = new Date().toISOString();
  mRow.migration_message = prepared.reduced
    ? `reduced ${formatFileSizeBytes(prepared.originalBytes)} → ${formatFileSizeBytes(prepared.finalBytes)}`
    : "";
  saveMediaSheet(mediaSheetPath, mediaRows);

  map.set({
    wpId: attachmentId,
    kind: "asset",
    assetUid: uploaded.uid,
    sourceKey: mRow.wp_slug,
    migratedAt: new Date().toISOString(),
    locale,
  });
  await map.save();

  return uploaded.uid;
}
