import { loadAssetMigrationSettings } from "../config.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { MappingStore } from "../mapping-store.js";
import { kindFromMimeType } from "./mime.js";
import type { MediaSheetRow, WpMediaItem } from "./types.js";
import { filenameForMedia, stripHtml } from "./utils.js";
import { WordPressClient } from "../wordpress/client.js";

export async function ensureAssetFolderUid(
  map: MappingStore,
  cs: ContentstackManagementClient
): Promise<string> {
  const settings = loadAssetMigrationSettings();
  let folderUid = process.env.CS_ASSET_FOLDER_UID || map.getWpMediaAssetFolderUid();
  if (folderUid) return folderUid;

  try {
    const existingFolders = await cs.getAssetFolders();
    const existing = existingFolders.find(
      (f) => f.name === settings.folderName && f.parent_uid === settings.parentFolderUid
    );
    if (existing) {
      map.setWpMediaAssetFolderUid(existing.uid);
      await map.save().catch(() => undefined);
      return existing.uid;
    }
  } catch {
    // proceed to create
  }

  const created = await cs.createAssetFolder(settings.folderName, settings.parentFolderUid);
  map.setWpMediaAssetFolderUid(created.uid);
  await map.save().catch(() => undefined);
  return created.uid;
}

export async function migrateOneMediaRow(
  row: MediaSheetRow,
  wp: WordPressClient,
  cs: ContentstackManagementClient,
  map: MappingStore,
  folderUid: string,
  locale?: string
): Promise<{ uid: string; type: string }> {
  const mimeType = row.mime_type;
  const mediaKind = kindFromMimeType(mimeType);
  const title = row.wp_title || `wp-media-${row.wp_id}`;
  const filename = filenameForMedia({
    id: row.wp_id,
    mime_type: mimeType,
    slug: row.wp_slug,
    source_url: row.wp_source_url,
    title: { rendered: row.wp_title },
  });
  const { buffer, contentType } = await wp.fetchBinary(row.wp_source_url);
  const uploaded = await cs.uploadAssetFile({
    buffer,
    filename,
    contentType: mimeType || contentType,
    title,
    parentFolderUid: folderUid,
  });

  if (mediaKind === "image") {
    map.set({
      wpId: row.wp_id,
      kind: "asset",
      assetUid: uploaded.uid,
      sourceKey: row.wp_slug,
      migratedAt: new Date().toISOString(),
      locale,
    });
    return { uid: uploaded.uid, type: "asset" };
  }

  if (mediaKind === "video") {
    const videoType = process.env.CS_CONTENT_TYPE_VIDEO;
    const videoAssetFieldUid = process.env.CS_VIDEO_ASSET_FIELD_UID ?? "video_file";
    if (!videoType) {
      throw new Error("Set CS_CONTENT_TYPE_VIDEO for video migration");
    }
    const entry = await cs.createEntry(
      videoType,
      {
        title,
        [videoAssetFieldUid]: [{ uid: uploaded.uid }],
      },
      locale
    );
    map.set({
      wpId: row.wp_id,
      kind: "custom",
      contentstackUid: entry.uid,
      sourceKey: row.wp_slug,
      migratedAt: new Date().toISOString(),
      locale,
    });
    return { uid: entry.uid, type: "entry:video" };
  }

  if (mediaKind === "document") {
    const docsType = process.env.CS_CONTENT_TYPE_DOCUMENT;
    const docsAssetFieldUid = process.env.CS_DOCUMENT_ASSET_FIELD_UID ?? "document_file";
    if (!docsType) {
      throw new Error("Set CS_CONTENT_TYPE_DOCUMENT for document migration");
    }
    const entry = await cs.createEntry(
      docsType,
      {
        title,
        [docsAssetFieldUid]: [{ uid: uploaded.uid }],
      },
      locale
    );
    map.set({
      wpId: row.wp_id,
      kind: "custom",
      contentstackUid: entry.uid,
      sourceKey: row.wp_slug,
      migratedAt: new Date().toISOString(),
      locale,
    });
    return { uid: entry.uid, type: "entry:document" };
  }

  throw new Error(`Unsupported mime_type for migration: ${mimeType}`);
}

/** Fetch a single media object from WordPress REST. */
export async function fetchWpMediaItem(wp: WordPressClient, id: number): Promise<WpMediaItem> {
  return wp.getJson<WpMediaItem>(`/wp-json/wp/v2/media/${id}`);
}

export function mediaRowFromWpItem(item: WpMediaItem): MediaSheetRow {
  return {
    wp_id: item.id,
    mime_type: item.mime_type,
    media_kind: kindFromMimeType(item.mime_type),
    wp_slug: item.slug ?? "",
    wp_source_url: item.source_url ?? "",
    wp_title: item.title?.rendered ? stripHtml(item.title.rendered) : "",
    migration_status: "Pending",
    contentstack_uid: "",
    contentstack_type: "",
    migration_message: "",
    migrated_at: "",
  };
}
