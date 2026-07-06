import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import type { ContentstackManagementClient } from "../contentstack/client.js";
import { WordPressClient } from "../wordpress/client.js";
import { findWordPressMediaByUrlWithClient, normalizeUrl } from "../wordpress/find-media-by-url.js";
import {
  resolveWpImageAssetUid,
  tryResolveWpImageAssetUid,
  type ResolvedWpImageAsset,
  type ResolveWpImageAssetOpts,
} from "./resolve-wp-image-asset.js";
import { prepareImageUploadBuffer } from "./image-compress.js";
import {
  csAssetFileSizeBytes,
  exceedsImageSizeLimit,
  imageOversizedWarning,
  loadMigrationImageMaxBytes,
  type MigrationWarnings,
} from "./image-size-limit.js";
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

function mapSourceKeyForImageUrl(url: string): string {
  return normalizeUrl(url) || url.trim().toLowerCase();
}

function filenameFromImageUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg && seg.includes(".")) return decodeURIComponent(seg);
  } catch {
    // ignore
  }
  return "og-image.jpg";
}

function fetchUrlsToTry(imageUrl: string): string[] {
  const trimmed = imageUrl.trim();
  const withoutQuery = trimmed.split("?")[0]!;
  const out = [withoutQuery];
  if (withoutQuery !== trimmed) out.push(trimmed);
  return out;
}

async function assetUidWithinSizeLimit(
  cs: ContentstackManagementClient,
  assetUid: string,
  attachmentId: number,
  purpose: string,
  warnings?: MigrationWarnings
): Promise<boolean> {
  const max = loadMigrationImageMaxBytes();
  const csSize = await csAssetFileSizeBytes(cs, assetUid);
  if (csSize !== undefined && exceedsImageSizeLimit(csSize, max)) {
    const msg = imageOversizedWarning(purpose, attachmentId, csSize, max);
    warnings?.add(msg);
    console.error(`[asset] WARNING: ${msg}`);
    return false;
  }
  return true;
}

/**
 * Fetch image bytes from a public WP uploads URL and create a Contentstack asset.
 * Used when Yoast `og_image` URLs (with crop/query params) do not match a media attachment.
 */
async function uploadImageAssetFromUrl(
  opts: ResolveWpImageFromUrlOpts
): Promise<ResolvedWpImageAsset | undefined> {
  const url = opts.imageUrl.trim();
  const sourceKey = mapSourceKeyForImageUrl(url);
  const cached = opts.map.get("asset", 0, opts.locale, sourceKey);
  if (cached?.assetUid && (await opts.cs.assetExists(cached.assetUid))) {
    const ok = await assetUidWithinSizeLimit(
      opts.cs,
      cached.assetUid,
      0,
      opts.purpose,
      opts.warnings
    );
    if (ok) {
      return { assetUid: cached.assetUid, source: "map" };
    }
  }

  let buffer: Buffer | undefined;
  let contentType = "image/jpeg";
  for (const fetchUrl of fetchUrlsToTry(url)) {
    try {
      const fetched = await opts.wp.fetchBinary(fetchUrl);
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[asset] fetch ${fetchUrl} failed: ${msg.slice(0, 160)}`);
    }
  }
  if (!buffer) return undefined;

  const filename = filenameFromImageUrl(url);
  const prepared = await prepareImageUploadBuffer({
    buffer,
    contentType,
    filename,
  });
  if (prepared.warning) {
    console.error(`[asset] ${opts.purpose}: ${prepared.warning}`);
  }

  const uploaded = await opts.cs.uploadAssetFile({
    buffer: prepared.buffer,
    filename: prepared.filename,
    contentType: prepared.contentType,
    title: prepared.filename,
    parentFolderUid: opts.folderUid,
  });

  opts.map.set({
    wpId: 0,
    kind: "asset",
    assetUid: uploaded.uid,
    sourceKey,
    migratedAt: new Date().toISOString(),
    locale: opts.locale,
  });
  await opts.map.save().catch(() => undefined);

  console.error(
    `[asset] uploaded image from URL → uid=${uploaded.uid} (${opts.purpose}) ` +
      `${prepared.originalBytes}→${prepared.outputBytes} bytes`
  );

  return { assetUid: uploaded.uid, source: "migrated_on_demand" };
}

/**
 * Resolve a WordPress media URL (e.g. Yoast `og_image.url`) to a Contentstack asset UID.
 */
export async function resolveWpImageAssetFromUrl(
  opts: ResolveWpImageFromUrlOpts
): Promise<ResolvedWpImageAsset | undefined> {
  const url = opts.imageUrl?.trim();
  if (!url) return undefined;

  const found = await findWordPressMediaByUrlWithClient(url, opts.wp);
  if (found) {
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

  return uploadImageAssetFromUrl(opts);
}

/** Like `resolveWpImageAssetFromUrl` but skips oversized images without throwing. */
export async function tryResolveWpImageAssetFromUrl(
  opts: ResolveWpImageFromUrlOpts
): Promise<ResolvedWpImageAsset | undefined> {
  const url = opts.imageUrl?.trim();
  if (!url) return undefined;

  const found = await findWordPressMediaByUrlWithClient(url, opts.wp);
  if (found) {
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
    const resolved = await tryResolveWpImageAssetUid(base);
    if (resolved) return resolved;
    console.error(
      `[asset] WP media id=${found.media.id} from URL lookup failed; uploading from URL (${opts.purpose}): ${url.slice(0, 120)}`
    );
  } else {
    console.error(
      `[asset] no WP media attachment for URL; uploading from URL (${opts.purpose}): ${url.slice(0, 120)}`
    );
  }

  const uploaded = await uploadImageAssetFromUrl(opts);
  if (!uploaded) {
    const warning = `${opts.purpose}: image URL could not be fetched or uploaded (${url.slice(0, 120)})`;
    opts.warnings?.add(warning);
    console.error(`[asset] WARNING: ${warning}`);
    return undefined;
  }

  const ok = await assetUidWithinSizeLimit(
    opts.cs,
    uploaded.assetUid,
    0,
    opts.purpose,
    opts.warnings
  );
  return ok ? uploaded : undefined;
}

export type TryResolveWpImageWithFallbackOpts = Omit<ResolveWpImageAssetOpts, "attachmentId"> & {
  attachmentId?: number;
  imageUrl?: string;
};

/**
 * Resolve by WP attachment id, then fall back to fetching `imageUrl` (compress + upload).
 * Never throws — warnings are recorded when both paths fail.
 */
export async function tryResolveWpImageWithFallback(
  opts: TryResolveWpImageWithFallbackOpts
): Promise<ResolvedWpImageAsset | undefined> {
  const { attachmentId, imageUrl } = opts;
  const url = imageUrl?.trim();

  if (attachmentId && attachmentId > 0) {
    const resolved = await tryResolveWpImageAssetUid({ ...opts, attachmentId });
    if (resolved) return resolved;

    if (url) {
      console.error(
        `[asset] wp_id=${attachmentId} not resolved; trying image URL (${opts.purpose}): ${url.slice(0, 120)}`
      );
      const fromUrl = await tryResolveWpImageAssetFromUrl({
        ...opts,
        imageUrl: url,
        purpose: `${opts.purpose} (URL fallback after wp_id=${attachmentId})`,
      });
      if (fromUrl) return fromUrl;
    }

    const warning = url
      ? `${opts.purpose}: wp_id=${attachmentId} and image URL could not be resolved`
      : `${opts.purpose}: wp_id=${attachmentId} could not be resolved`;
    opts.warnings?.add(warning);
    console.error(`[asset] WARNING: ${warning}`);
    return undefined;
  }

  if (url) {
    return tryResolveWpImageAssetFromUrl({ ...opts, imageUrl: url });
  }

  return undefined;
}
