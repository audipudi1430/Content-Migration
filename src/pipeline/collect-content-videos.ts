import { extractWpContentBlocks, normalizeWpBlock, type WpContentBlock } from "./blog-body-content.js";
import { pickMetaString } from "./blog-payload.js";

export type ContentVideoRef = {
  videoUrl: string;
  /** Source label for the audit sheet. */
  videoType: string;
  providerSlug: string;
};

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function pushRef(out: ContentVideoRef[], ref: ContentVideoRef): void {
  const videoUrl = pickString(ref.videoUrl);
  if (!videoUrl) return;
  out.push({
    videoUrl,
    videoType: pickString(ref.videoType) || "video",
    providerSlug: pickString(ref.providerSlug),
  });
}

const FEATURED_VIDEO_META_KEYS = [
  "featured_video_url",
  "featured_video",
  "featured_video_link",
];

function collectEmbedRefsFromBlocks(blocks: WpContentBlock[], out: ContentVideoRef[]): void {
  for (const raw of blocks) {
    const block = normalizeWpBlock(raw);
    const name = (block.blockName ?? block.name ?? "").trim().toLowerCase();
    const attrs = { ...(block.attrs ?? {}), ...(block.attributes ?? {}) };

    if (name === "core/embed" || name === "core/video") {
      const embedUrl = pickString(attrs.url) || pickString(attrs.src);
      const providerSlug = pickString(attrs.providerNameSlug);
      if (embedUrl) {
        pushRef(out, {
          videoUrl: embedUrl,
          videoType: name === "core/video" ? "core/video" : "core/embed",
          providerSlug,
        });
      }
    }

    if (block.innerBlocks?.length) {
      collectEmbedRefsFromBlocks(block.innerBlocks, out);
    }
  }
}

/** Collect video URLs from a WordPress story (embed blocks + `meta.featured_video_url`). */
export function collectStoryVideoRefs(story: Record<string, unknown>): ContentVideoRef[] {
  const out: ContentVideoRef[] = [];

  const meta =
    story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
      ? (story.meta as Record<string, unknown>)
      : undefined;

  for (const key of FEATURED_VIDEO_META_KEYS) {
    const url = pickMetaString(meta, key);
    if (url) {
      pushRef(out, {
        videoUrl: url,
        videoType: `meta (${key})`,
        providerSlug: "",
      });
    }
  }

  const blocks = extractWpContentBlocks(story);
  if (blocks.length > 0) {
    collectEmbedRefsFromBlocks(blocks, out);
  }

  return out;
}

export function dedupeContentVideoRefs(refs: ContentVideoRef[]): ContentVideoRef[] {
  const seen = new Set<string>();
  const out: ContentVideoRef[] = [];
  for (const ref of refs) {
    const key = `${ref.videoType}\t${ref.videoUrl.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
