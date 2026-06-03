import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { findWordPressMediaByUrlWithClient } from "../wordpress/find-media-by-url.js";
import { resolveWpImageAssetUid, type ResolvedWpImageAsset } from "./resolve-wp-image-asset.js";
import type { TrackingRow } from "./types.js";

/**
 * Resolve a WordPress media URL (e.g. Yoast `og_image.url`) to a Contentstack asset UID.
 */
export async function resolveWpImageAssetFromUrl(opts: {
  imageUrl: string;
  wp: WordPressClient;
  cs: ContentstackManagementClient;
  map: MappingStore;
  mediaSheetPath: string;
  folderUid: string;
  locale: string | undefined;
  purpose: string;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
}): Promise<ResolvedWpImageAsset | undefined> {
  const url = opts.imageUrl?.trim();
  if (!url) return undefined;

  const found = await findWordPressMediaByUrlWithClient(url, opts.wp);
  if (!found) return undefined;

  return resolveWpImageAssetUid({
    attachmentId: found.media.id,
    wp: opts.wp,
    cs: opts.cs,
    map: opts.map,
    mediaSheetPath: opts.mediaSheetPath,
    folderUid: opts.folderUid,
    locale: opts.locale,
    purpose: opts.purpose,
    paths: opts.paths,
    allTracking: opts.allTracking,
  });
}
