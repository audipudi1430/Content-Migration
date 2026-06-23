import { pickYoastOgImageUrl, type WpAuthorSeoSource } from "./blog-author-seo.js";
import {
  extractWpContentBlocks,
  normalizeWpBlock,
  parseRenderedHtmlSegments,
  type WpContentBlock,
} from "./blog-body-content.js";
import { pickFeaturedMediaId } from "./blog-payload.js";
import {
  isFeaturedImageBlockName,
  isHeroMediaBlockName,
  pickMediaIdFromBlockAttrs,
} from "./story-thumbnail-source.js";

export type ContentImageRef = {
  attachmentId?: number;
  imageUrl?: string;
  /** Usage label for audit sheet (e.g. `featured_media`, `hero (vmware/hero)`). */
  imageType: string;
};

function pickPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function pushRef(out: ContentImageRef[], ref: ContentImageRef): void {
  const attachmentId = ref.attachmentId;
  const imageUrl = pickString(ref.imageUrl);
  const imageType = pickString(ref.imageType);
  if ((!attachmentId || attachmentId <= 0) && !imageUrl) return;
  if (!imageType) return;
  out.push({
    attachmentId: attachmentId && attachmentId > 0 ? attachmentId : undefined,
    imageUrl: imageUrl || undefined,
    imageType,
  });
}

function pickRenderedContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const rendered = (content as { rendered?: unknown }).rendered;
    if (typeof rendered === "string") return rendered.trim();
  }
  return "";
}

function parseFigureImage(html: string): { src: string; attachmentId?: number } {
  const src = /src=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const classAttr = /class=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const idMatch = /wp-image-(\d+)/i.exec(classAttr);
  const attachmentId = idMatch ? Number(idMatch[1]) : undefined;
  return { src, attachmentId };
}

function collectImgRefsFromHtml(html: string, out: ContentImageRef[], imageType: string): void {
  const re = /<img[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0] ?? "";
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const classAttr = /class=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const idMatch = /wp-image-(\d+)/i.exec(classAttr);
    const attachmentId = idMatch ? Number(idMatch[1]) : undefined;
    pushRef(out, { attachmentId, imageUrl: src, imageType });
  }
}

function walkHeroAndFeaturedBlockRefs(
  blocks: WpContentBlock[],
  out: ContentImageRef[]
): void {
  for (const raw of blocks) {
    const block = normalizeWpBlock(raw);
    const name = (block.blockName ?? block.name ?? "").trim().toLowerCase();
    const attrs = { ...(block.attrs ?? {}), ...(block.attributes ?? {}) };
    const attachmentId = pickMediaIdFromBlockAttrs(attrs);

    if (attachmentId && isHeroMediaBlockName(name)) {
      pushRef(out, {
        attachmentId,
        imageType: `hero (${name || "block"})`,
      });
    } else if (attachmentId && isFeaturedImageBlockName(name)) {
      pushRef(out, {
        attachmentId,
        imageType: `featured_media (${name})`,
      });
    }

    if (block.innerBlocks?.length) {
      walkHeroAndFeaturedBlockRefs(block.innerBlocks, out);
    }
  }
}

function collectImageRefsFromBlocks(blocks: WpContentBlock[], out: ContentImageRef[]): void {
  for (const raw of blocks) {
    const block = normalizeWpBlock(raw);
    const name = (block.blockName ?? block.name ?? "").trim().toLowerCase();
    const attrs = { ...(block.attrs ?? {}), ...(block.attributes ?? {}) };

    if (isHeroMediaBlockName(name) || isFeaturedImageBlockName(name)) {
      if (block.innerBlocks?.length) {
        collectImageRefsFromBlocks(block.innerBlocks, out);
      }
      continue;
    }

    if (name === "core/image") {
      pushRef(out, {
        attachmentId: pickPositiveInt(attrs.id),
        imageUrl: pickString(attrs.url),
        imageType: "body_image (core/image)",
      });
    } else if (name === "core/media-text") {
      pushRef(out, {
        attachmentId: pickPositiveInt(attrs.mediaId),
        imageUrl: pickString(attrs.mediaUrl),
        imageType: "body_image (core/media-text)",
      });
    } else if (name === "core/cover") {
      pushRef(out, {
        attachmentId: pickPositiveInt(attrs.id),
        imageUrl: pickString(attrs.url),
        imageType: "body_image (core/cover)",
      });
    } else if (name === "core/gallery") {
      const ids = attrs.ids;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const attachmentId = pickPositiveInt(id);
          if (attachmentId) {
            pushRef(out, { attachmentId, imageType: "body_image (core/gallery)" });
          }
        }
      }
    }

    const innerHtml = pickString(block.innerHTML);
    if (innerHtml) {
      collectImgRefsFromHtml(innerHtml, out, `body_image (${name || "block"})`);
    }

    const contentHtml = pickString(attrs.content);
    if (contentHtml && /<img[\s>]/i.test(contentHtml)) {
      collectImgRefsFromHtml(contentHtml, out, `body_image (${name || "block"})`);
    }

    if (block.innerBlocks?.length) {
      collectImageRefsFromBlocks(block.innerBlocks, out);
    }
  }
}

function collectImageRefsFromRendered(story: Record<string, unknown>, out: ContentImageRef[]): void {
  const rendered = pickRenderedContent(story.content);
  if (!rendered) return;

  for (const seg of parseRenderedHtmlSegments(rendered)) {
    if (seg.kind === "figure") {
      const parsed = parseFigureImage(seg.html);
      pushRef(out, {
        attachmentId: parsed.attachmentId,
        imageUrl: parsed.src,
        imageType: "body_image (rendered_html figure)",
      });
      continue;
    }
    if (seg.kind === "image") {
      pushRef(out, { imageUrl: seg.src, imageType: "body_image (rendered_html img)" });
      continue;
    }
    if (seg.kind === "paragraph" || seg.kind === "list" || seg.kind === "quote") {
      collectImgRefsFromHtml(seg.html, out, "body_image (rendered_html)");
    }
  }
}

function collectBodyImageRefs(story: Record<string, unknown>, out: ContentImageRef[]): void {
  const blocks = extractWpContentBlocks(story);
  if (blocks.length > 0) {
    collectImageRefsFromBlocks(blocks, out);
  }
  collectImageRefsFromRendered(story, out);
}

function pickAuthorAvatarAttachmentId(
  term: Record<string, unknown>,
  meta: Record<string, unknown>
): number | undefined {
  return (
    pickPositiveInt(meta.avatar_image_id) ||
    pickPositiveInt(meta.avatar) ||
    pickPositiveInt(meta.image_id) ||
    pickPositiveInt(term.featured_media) ||
    undefined
  );
}

export function collectStoryImageRefs(story: Record<string, unknown>): ContentImageRef[] {
  const out: ContentImageRef[] = [];
  const blocks = extractWpContentBlocks(story);

  walkHeroAndFeaturedBlockRefs(blocks, out);

  const featured = pickFeaturedMediaId(story);
  if (featured) {
    pushRef(out, { attachmentId: featured, imageType: "featured_media" });
  }

  const ogImageUrl = pickYoastOgImageUrl(story as WpAuthorSeoSource);
  if (ogImageUrl) {
    pushRef(out, { imageUrl: ogImageUrl, imageType: "meta_image" });
  }

  collectBodyImageRefs(story, out);
  return out;
}

export function collectCategoryImageRefs(term: Record<string, unknown>): ContentImageRef[] {
  const out: ContentImageRef[] = [];
  const ogImageUrl = pickYoastOgImageUrl(term as WpAuthorSeoSource);
  if (ogImageUrl) {
    pushRef(out, { imageUrl: ogImageUrl, imageType: "meta_image" });
  }
  return out;
}

export function collectAuthorImageRefs(term: Record<string, unknown>): ContentImageRef[] {
  const out: ContentImageRef[] = [];
  const meta =
    term.meta && typeof term.meta === "object" && !Array.isArray(term.meta)
      ? (term.meta as Record<string, unknown>)
      : {};

  const avatarId = pickAuthorAvatarAttachmentId(term, meta);
  if (avatarId) {
    pushRef(out, { attachmentId: avatarId, imageType: "author_image" });
  }

  const metaImageId = pickPositiveInt(meta.downloadable_image_id);
  if (metaImageId) {
    pushRef(out, { attachmentId: metaImageId, imageType: "author_downloadable_image" });
  }

  const ogImageUrl = pickYoastOgImageUrl(term as WpAuthorSeoSource);
  if (ogImageUrl) {
    pushRef(out, { imageUrl: ogImageUrl, imageType: "meta_image" });
  }

  return out;
}

export function dedupeContentImageRefs(refs: ContentImageRef[]): ContentImageRef[] {
  const seen = new Set<string>();
  const out: ContentImageRef[] = [];
  for (const ref of refs) {
    const key = `${ref.imageType}\t${ref.attachmentId ?? ""}\t${(ref.imageUrl ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
