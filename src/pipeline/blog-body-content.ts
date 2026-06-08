import type { BlogBodyBlockUids, BlogBodySource } from "./blog-body-config.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import { htmlToPlainWithBreaks, stripUnsafeHtml } from "./contentstack-rte.js";

export type WpContentBlock = {
  blockName?: string | null;
  attrs?: Record<string, unknown>;
  innerBlocks?: WpContentBlock[];
  innerHTML?: string;
  innerContent?: unknown[];
};

export type BodyImageResolver = (opts: {
  attachmentId?: number;
  imageUrl?: string;
  purpose: string;
}) => Promise<string | undefined>;

export type BodyContentBuildResult = {
  blocks: Record<string, unknown>[];
  stats: {
    text: number;
    image: number;
    imageTextWrap: number;
    pullQuote: number;
    video: number;
    skipped: number;
    source: "wp_blocks" | "rendered_html";
  };
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

function stripTags(html: string): string {
  return htmlToPlainWithBreaks(html);
}

function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

function wrapModularBlock(blockUid: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { [blockUid]: compactFields(fields) };
}

function pickRenderedContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object" && "rendered" in content) {
    return pickString((content as { rendered?: unknown }).rendered);
  }
  return "";
}

function pickRawContent(content: unknown): string {
  if (content && typeof content === "object" && "raw" in content) {
    return pickString((content as { raw?: unknown }).raw);
  }
  return "";
}

/** Collect WP blocks from common REST shapes (`blocks`, `content.blocks`, Gutenberg raw). */
export function extractWpContentBlocks(story: Record<string, unknown>): WpContentBlock[] {
  const top = story.blocks;
  if (Array.isArray(top) && top.length > 0) {
    return top as WpContentBlock[];
  }

  const content = story.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentBlocks = (content as { blocks?: unknown }).blocks;
    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      return contentBlocks as WpContentBlock[];
    }
    const raw = pickRawContent(content);
    if (raw.includes("<!-- wp:")) {
      const parsed = parseGutenbergRawTopLevel(raw);
      if (parsed.length > 0) return parsed;
    }
  }

  const meta = story.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const metaBlocks = (meta as { blocks?: unknown }).blocks;
    if (Array.isArray(metaBlocks) && metaBlocks.length > 0) {
      return metaBlocks as WpContentBlock[];
    }
  }

  return [];
}

/** Parse top-level `<!-- wp:name {...} -->...<!-- /wp:name -->` segments (no nesting). */
export function parseGutenbergRawTopLevel(raw: string): WpContentBlock[] {
  const blocks: WpContentBlock[] = [];
  const re =
    /<!--\s*wp:([a-z0-9/-]+)(?:\s+(\{[\s\S]*?\}))?\s*(?:\/)?-->([\s\S]*?)(?:<!--\s*\/wp:\1\s*-->)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const blockName = m[1] ?? "";
    const attrsJson = m[2]?.trim();
    const inner = (m[3] ?? "").trim();
    let attrs: Record<string, unknown> = {};
    if (attrsJson) {
      try {
        attrs = JSON.parse(attrsJson) as Record<string, unknown>;
      } catch {
        attrs = {};
      }
    }
    if (blockName.endsWith("/")) continue;
    blocks.push({
      blockName,
      attrs,
      innerHTML: inner,
      innerBlocks: [],
    });
  }
  return blocks;
}

type HtmlSegment =
  | { kind: "heading"; level: number; html: string }
  | { kind: "paragraph"; html: string }
  | { kind: "figure"; html: string }
  | { kind: "quote"; html: string }
  | { kind: "image"; html: string; src: string; alt: string };

/** Split rendered HTML into ordered top-level segments for fallback mapping. */
export function parseRenderedHtmlSegments(html: string): HtmlSegment[] {
  const input = stripUnsafeHtml(html);
  if (!input) return [];

  type Match = { index: number; segment: HtmlSegment };
  const matches: Match[] = [];

  const patterns: { re: RegExp; build: (m: RegExpExecArray) => HtmlSegment | undefined }[] = [
    {
      re: /<(h[1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi,
      build: (m) => ({
        kind: "heading",
        level: Number(m[1]!.slice(1)),
        html: m[0] ?? "",
      }),
    },
    {
      re: /<figure[^>]*>[\s\S]*?<\/figure>/gi,
      build: (m) => ({ kind: "figure", html: m[0] ?? "" }),
    },
    {
      re: /<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi,
      build: (m) => ({ kind: "quote", html: m[0] ?? "" }),
    },
    {
      re: /<p[^>]*>[\s\S]*?<\/p>/gi,
      build: (m) => ({ kind: "paragraph", html: m[0] ?? "" }),
    },
    {
      re: /<img[^>]+>/gi,
      build: (m) => {
        const tag = m[0] ?? "";
        const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
        const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
        if (!src) return undefined;
        return { kind: "image", html: tag, src, alt };
      },
    },
  ];

  for (const { re, build } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const segment = build(m);
      if (segment) matches.push({ index: m.index, segment });
    }
  }

  matches.sort((a, b) => a.index - b.index);

  const used = new Set<number>();
  const out: HtmlSegment[] = [];
  for (const { index, segment } of matches) {
    if (used.has(index)) continue;
    used.add(index);
    out.push(segment);
  }

  if (out.length === 0 && input.trim()) {
    out.push({ kind: "paragraph", html: input });
  }

  return out;
}

function parseQuoteFromHtml(html: string): { quote: string; author: string; groupTitle: string } {
  const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(html)?.[1] ?? "";
  const author = stripTags(cite);
  const quoteHtml = html
    .replace(/<cite[^>]*>[\s\S]*?<\/cite>/gi, "")
    .replace(/<\/?blockquote[^>]*>/gi, "")
    .trim();
  const quote = stripUnsafeHtml(quoteHtml);
  return { quote, author, groupTitle: "" };
}

function parseFigureImage(html: string): { src: string; alt: string; caption: string; attachmentId?: number } {
  const src = /src=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const alt = /alt=["']([^"']*)["']/i.exec(html)?.[1] ?? "";
  const classAttr = /class=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const idMatch = /wp-image-(\d+)/i.exec(classAttr);
  const attachmentId = idMatch ? Number(idMatch[1]) : undefined;
  const captionHtml = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(html)?.[1] ?? "";
  const caption = stripTags(captionHtml);
  return { src, alt, caption, attachmentId };
}

function normalizeBlockName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

function isLayoutBlock(name: string): boolean {
  return (
    name === "core/group" ||
    name === "core/columns" ||
    name === "core/column" ||
    name === "core/spacer" ||
    name === "core/separator" ||
    name === "core/more" ||
    name === "core/nextpage"
  );
}

export async function buildBodyContentFromWpStory(
  story: Record<string, unknown>,
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  sourceMode: BlogBodySource = "blocks_then_rendered",
  log?: (msg: string) => void
): Promise<BodyContentBuildResult> {
  const stats = {
    text: 0,
    image: 0,
    imageTextWrap: 0,
    pullQuote: 0,
    video: 0,
    skipped: 0,
    source: "wp_blocks" as "wp_blocks" | "rendered_html",
  };

  const wpBlocks = extractWpContentBlocks(story);
  const useBlocks =
    sourceMode === "blocks" ||
    (sourceMode === "blocks_then_rendered" && wpBlocks.length > 0);

  if (useBlocks && wpBlocks.length > 0) {
    stats.source = "wp_blocks";
    const blocks = await convertWpBlocks(wpBlocks, uids, resolveImage, stats, log);
    return { blocks, stats };
  }

  const rendered = pickRenderedContent(story.content);
  if (!rendered) {
    return { blocks: [], stats };
  }

  stats.source = "rendered_html";
  const segments = parseRenderedHtmlSegments(rendered);
  const blocks: Record<string, unknown>[] = [];

  for (const seg of segments) {
    if (seg.kind === "heading") {
      const text = stripTags(seg.html);
      if (!text) continue;
      const fields =
        seg.level <= 2
          ? { [uids.text.groupTitle]: text }
          : { [uids.text.subhead]: text };
      blocks.push(wrapModularBlock(uids.text.blockUid, fields));
      stats.text += 1;
      continue;
    }

    if (seg.kind === "paragraph") {
      const text = stripUnsafeHtml(seg.html);
      if (!text) continue;
      blocks.push(wrapModularBlock(uids.text.blockUid, { [uids.text.text]: text }));
      stats.text += 1;
      continue;
    }

    if (seg.kind === "quote") {
      const { quote, author } = parseQuoteFromHtml(seg.html);
      if (!quote) continue;
      blocks.push(
        wrapModularBlock(uids.pullQuote.blockUid, {
          [uids.pullQuote.quote]: quote,
          [uids.pullQuote.author]: author,
        })
      );
      stats.pullQuote += 1;
      continue;
    }

    if (seg.kind === "image" || seg.kind === "figure") {
      const parsed = seg.kind === "figure" ? parseFigureImage(seg.html) : { src: seg.src, alt: seg.alt, caption: "" };
      const assetUid = await resolveImage({
        attachmentId: "attachmentId" in parsed ? parsed.attachmentId : undefined,
        imageUrl: parsed.src,
        purpose: "body image (rendered html)",
      });
      if (!assetUid) {
        stats.skipped += 1;
        log?.(`skipped image (no asset): ${parsed.src}`);
        continue;
      }
      const imageFields: Record<string, unknown> = {
        [uids.image.file]: contentstackFileRefValue(assetUid, uids.fileRefShape),
        [uids.image.caption]: parsed.caption || parsed.alt,
      };
      if (uids.imageEnlargeDefault !== undefined) {
        imageFields[uids.image.enlarge] = uids.imageEnlargeDefault;
      }
      blocks.push(wrapModularBlock(uids.image.blockUid, imageFields));
      stats.image += 1;
    }
  }

  return { blocks, stats };
}

async function convertWpBlocks(
  wpBlocks: WpContentBlock[],
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  stats: BodyContentBuildResult["stats"],
  log?: (msg: string) => void
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];

  for (const block of wpBlocks) {
    const converted = await convertOneWpBlock(block, uids, resolveImage, stats, log);
    out.push(...converted);
  }

  return out;
}

async function convertOneWpBlock(
  block: WpContentBlock,
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  stats: BodyContentBuildResult["stats"],
  log?: (msg: string) => void
): Promise<Record<string, unknown>[]> {
  const name = normalizeBlockName(block.blockName);
  const result: Record<string, unknown>[] = [];

  if (!name || isLayoutBlock(name)) {
    const inner = block.innerBlocks ?? [];
    const nested: Record<string, unknown>[] = [];
    for (const child of inner) {
      nested.push(...(await convertOneWpBlock(child, uids, resolveImage, stats, log)));
    }
    return nested;
  }

  if (name === "core/paragraph" || name === "core/freeform") {
    const html = stripUnsafeHtml(block.innerHTML ?? "");
    if (!html) return [];
    outPushText(uids, { text: html }, stats, result);
    return result;
  }

  if (name === "core/heading") {
    const level = pickPositiveInt(block.attrs?.level) ?? 2;
    const text = stripTags(block.innerHTML ?? "");
    if (!text) return [];
    const fields =
      level <= 2
        ? { [uids.text.groupTitle]: text }
        : { [uids.text.subhead]: text };
    result.push(wrapModularBlock(uids.text.blockUid, fields));
    stats.text += 1;
    return result;
  }

  if (name === "core/image") {
    const attachmentId = pickPositiveInt(block.attrs?.id);
    const imageUrl = pickString(block.attrs?.url);
    const caption = pickString(block.attrs?.caption) || pickString(block.attrs?.alt);
    const assetUid = await resolveImage({
      attachmentId,
      imageUrl,
      purpose: "body image (core/image)",
    });
    if (!assetUid) {
      stats.skipped += 1;
      log?.(`skipped core/image wp attachment=${attachmentId ?? "?"} url=${imageUrl || "(none)"}`);
      return [];
    }
    const imageFields: Record<string, unknown> = {
      [uids.image.file]: contentstackFileRefValue(assetUid, uids.fileRefShape),
      [uids.image.caption]: caption,
    };
    if (uids.imageEnlargeDefault !== undefined) {
      imageFields[uids.image.enlarge] = uids.imageEnlargeDefault;
    }
    result.push(wrapModularBlock(uids.image.blockUid, imageFields));
    stats.image += 1;
    return result;
  }

  if (name === "core/media-text") {
    const attachmentId = pickPositiveInt(block.attrs?.mediaId);
    const imageUrl = pickString(block.attrs?.mediaUrl);
    const assetUid = await resolveImage({
      attachmentId,
      imageUrl,
      purpose: "body image (core/media-text)",
    });
    const textHtml = stripUnsafeHtml(
      (block.innerBlocks ?? [])
        .map((b) => b.innerHTML ?? "")
        .join("")
        .trim() || block.innerHTML || ""
    );
    if (!assetUid && !textHtml) {
      stats.skipped += 1;
      return [];
    }
    const fields: Record<string, unknown> = {};
    if (assetUid) {
      fields[uids.imageTextWrap.image] = compactFields({
        [uids.imageTextWrap.imageFile]: contentstackFileRefValue(assetUid, uids.fileRefShape),
        ...(uids.imageEnlargeDefault !== undefined
          ? { [uids.imageTextWrap.imageEnlarge]: uids.imageEnlargeDefault }
          : {}),
        ...(pickString(block.attrs?.mediaPosition)
          ? { [uids.imageTextWrap.imagePosition]: pickString(block.attrs?.mediaPosition) }
          : {}),
      });
    }
    if (textHtml) {
      fields[uids.imageTextWrap.text] = { [uids.imageTextWrap.textBody]: textHtml };
    }
    result.push(wrapModularBlock(uids.imageTextWrap.blockUid, fields));
    stats.imageTextWrap += 1;
    return result;
  }

  if (name === "core/quote" || name === "core/pullquote") {
    const parsed = parseQuoteFromHtml(block.innerHTML ?? "");
    const quote =
      parsed.quote ||
      pickString(block.attrs?.value) ||
      stripTags(block.innerHTML ?? "");
    const author = parsed.author || pickString(block.attrs?.citation);
    if (!quote) {
      stats.skipped += 1;
      return [];
    }
    result.push(
      wrapModularBlock(uids.pullQuote.blockUid, {
        [uids.pullQuote.quote]: quote,
        [uids.pullQuote.author]: author,
      })
    );
    stats.pullQuote += 1;
    return result;
  }

  if (name === "core/embed" || name === "core/video") {
    const url = pickString(block.attrs?.url) || pickString(block.attrs?.src);
    if (!url) {
      stats.skipped += 1;
      return [];
    }
    result.push(wrapModularBlock(uids.video.blockUid, { [uids.video.video]: url }));
    stats.video += 1;
    return result;
  }

  // Unknown block: try innerHTML as text, else recurse inner blocks.
  if (block.innerHTML?.trim()) {
    const html = stripUnsafeHtml(block.innerHTML);
    if (html) {
      outPushText(uids, { text: html }, stats, result);
      log?.(`mapped unknown block ${name} as text`);
      return result;
    }
  }

  const inner = block.innerBlocks ?? [];
  if (inner.length > 0) {
    const nested: Record<string, unknown>[] = [];
    for (const child of inner) {
      nested.push(...(await convertOneWpBlock(child, uids, resolveImage, stats, log)));
    }
    return nested;
  }

  stats.skipped += 1;
  log?.(`skipped unmapped block ${name || "(empty)"}`);
  return [];
}

function outPushText(
  uids: BlogBodyBlockUids,
  fields: { groupTitle?: string; subhead?: string; text?: string },
  stats: BodyContentBuildResult["stats"],
  target: Record<string, unknown>[]
): void {
  const payload: Record<string, unknown> = {};
  if (fields.groupTitle) payload[uids.text.groupTitle] = fields.groupTitle;
  if (fields.subhead) payload[uids.text.subhead] = fields.subhead;
  if (fields.text) payload[uids.text.text] = fields.text;
  if (Object.keys(payload).length === 0) return;
  target.push(wrapModularBlock(uids.text.blockUid, payload));
  stats.text += 1;
}
