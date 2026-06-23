import {
  extractWpContentBlocks,
  normalizeWpBlock,
  type WpContentBlock,
} from "./blog-body-content.js";
import { pickFeaturedMediaId } from "./blog-payload.js";

export type WpFocalPoint = { x: number; y: number };

export type StoryThumbnailSource = {
  attachmentId: number;
  focalPoint?: WpFocalPoint;
  /** WordPress block name or `featured_media`. */
  source: string;
};

function pickPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function blockName(raw: WpContentBlock): string {
  return (raw.blockName ?? raw.name ?? "").trim().toLowerCase();
}

function blockAttrs(raw: WpContentBlock): Record<string, unknown> {
  return { ...(raw.attributes ?? {}), ...(raw.attrs ?? {}) };
}

/** Hero blocks such as `vmware/hero` (thumbnail source on VMware stories). */
export function isHeroMediaBlockName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "vmware/hero" || n.endsWith("/hero") || n.includes("hero");
}

/** WordPress featured-image block (`core/post-featured-image`). */
export function isFeaturedImageBlockName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "core/post-featured-image" || n === "core/featured-image";
}

/** Other media-like custom blocks that may carry `mediaId` + `focalPoint`. */
function isMediaLikeBlockName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    isHeroMediaBlockName(n) ||
    n.includes("media") ||
    n.includes("banner") ||
    n.includes("thumbnail")
  );
}

export function pickFocalPointFromAttrs(attrs: Record<string, unknown>): WpFocalPoint | undefined {
  const raw = attrs.focalPoint ?? attrs.focal_point;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const x = Number((raw as { x?: unknown }).x);
  const y = Number((raw as { y?: unknown }).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y };
}

export function pickMediaIdFromBlockAttrs(attrs: Record<string, unknown>): number | undefined {
  const fromMediaId =
    pickPositiveInt(attrs.mediaId) ??
    pickPositiveInt(attrs.media_id) ??
    pickPositiveInt(attrs.id) ??
    pickPositiveInt(attrs.featured_media);
  if (fromMediaId) return fromMediaId;

  const image = attrs.image;
  if (image && typeof image === "object" && !Array.isArray(image)) {
    return pickPositiveInt((image as { id?: unknown }).id);
  }
  return undefined;
}

type BlockMediaHit = StoryThumbnailSource & { isHero: boolean; isMediaLike: boolean };

function walkBlocksForMedia(blocks: WpContentBlock[]): BlockMediaHit[] {
  const hits: BlockMediaHit[] = [];
  for (const raw of blocks) {
    const block = normalizeWpBlock(raw);
    const name = blockName(block);
    const attrs = blockAttrs(block);
    const attachmentId = pickMediaIdFromBlockAttrs(attrs);
    if (attachmentId) {
      const isFeaturedBlock = isFeaturedImageBlockName(name);
      hits.push({
        attachmentId,
        focalPoint: pickFocalPointFromAttrs(attrs),
        source: name || "block",
        isHero: isHeroMediaBlockName(name),
        isMediaLike: isMediaLikeBlockName(name) || isFeaturedBlock,
      });
    }
    if (block.innerBlocks?.length) {
      hits.push(...walkBlocksForMedia(block.innerBlocks));
    }
  }
  return hits;
}

/**
 * Thumbnail image source for story migration:
 * 1. Hero block from `content.blocks` (`vmware/hero`, etc.) with optional `focalPoint`
 * 2. WordPress `featured_media` or `core/post-featured-image` block
 * 3. Other media-like blocks, then any block with a media ID
 */
export function pickStoryThumbnailSource(story: Record<string, unknown>): StoryThumbnailSource | undefined {
  const blocks = extractWpContentBlocks(story);
  const hits = walkBlocksForMedia(blocks);

  const heroHit = hits.find(
    (h) => isHeroMediaBlockName(h.source) && !isFeaturedImageBlockName(h.source)
  );
  if (heroHit) {
    return {
      attachmentId: heroHit.attachmentId,
      focalPoint: heroHit.focalPoint,
      source: heroHit.source,
    };
  }

  const featured = pickFeaturedMediaId(story);
  if (featured) {
    return { attachmentId: featured, source: "featured_media" };
  }

  const featuredBlockHit = hits.find((h) => isFeaturedImageBlockName(h.source));
  if (featuredBlockHit) {
    return {
      attachmentId: featuredBlockHit.attachmentId,
      focalPoint: featuredBlockHit.focalPoint,
      source: featuredBlockHit.source,
    };
  }

  const mediaHit = hits.find((h) => h.isMediaLike && !h.isHero);
  if (mediaHit) {
    return {
      attachmentId: mediaHit.attachmentId,
      focalPoint: mediaHit.focalPoint,
      source: mediaHit.source,
    };
  }

  const anyHit = hits.find((h) => !h.isHero);
  if (anyHit) {
    return {
      attachmentId: anyHit.attachmentId,
      focalPoint: anyHit.focalPoint,
      source: anyHit.source,
    };
  }

  return undefined;
}
