import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { findWordPressMediaByUrlWithClient } from "../wordpress/find-media-by-url.js";
import {
  resolveWpImageAssetUid,
  tryResolveWpImageAssetUid,
  type ResolvedWpImageAsset,
  type ResolveWpImageAssetOpts,
} from "./resolve-wp-image-asset.js";
import type { MigrationWarnings } from "./image-size-limit.js";
import type { TrackingRow } from "./types.js";

export type ResolveWpImageFromUrlOpts = {
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
  warnings?: MigrationWarnings;
};

/**
 * Resolve a WordPress media URL (e.g. Yoast `og_image.url`) to a Contentstack asset UID.
 */
export async function resolveWpImageAssetFromUrl(
  opts: ResolveWpImageFromUrlOpts
): Promise<ResolvedWpImageAsset | undefined> {
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

/** Like `resolveWpImageAssetFromUrl` but skips oversized images without throwing. */
export async function tryResolveWpImageAssetFromUrl(
  opts: ResolveWpImageFromUrlOpts
): Promise<ResolvedWpImageAsset | undefined> {
  const url = opts.imageUrl?.trim();
  if (!url) return undefined;

  const found = await findWordPressMediaByUrlWithClient(url, opts.wp);
  if (!found) return undefined;

  const base: ResolveWpImageAssetOpts = {
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
    warnings: opts.warnings,
  };
  return tryResolveWpImageAssetUid(base);
}
