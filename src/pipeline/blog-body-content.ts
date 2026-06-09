import type { BlogBodyBlockUids, BlogBodySource } from "./blog-body-config.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import { contentstackEntryRefValue } from "./blog-payload.js";
import { htmlToPlainWithBreaks, stripUnsafeHtml } from "./contentstack-rte.js";

/** WordPress block — supports Gutenberg REST (`name`/`attributes`) and classic (`blockName`/`attrs`). */
export type WpContentBlock = {
  blockName?: string | null;
  /** REST API block type, e.g. `core/paragraph`. */
  name?: string | null;
  attrs?: Record<string, unknown>;
  /** REST API block attributes (often includes `content`, `level`). */
  attributes?: Record<string, unknown>;
  innerBlocks?: WpContentBlock[];
  innerHTML?: string;
  innerContent?: unknown[];
  clientId?: string;
};

export type BodyImageResolver = (opts: {
  attachmentId?: number;
  imageUrl?: string;
  purpose: string;
}) => Promise<string | undefined>;

export type BodyVideoResolver = (opts: {
  attachmentId?: number;
  embedUrl?: string;
  purpose: string;
}) => Promise<string | undefined>;

export type BodyContentBuildResult = {
  blocks: Record<string, unknown>[];
  stats: {
    text: number;
    image: number;
    video: number;
    skipped: number;
    source: "wp_blocks" | "rendered_html";
  };
};

function imageBlockPayload(uids: BlogBodyBlockUids, assetUid: string): Record<string, unknown> {
  return wrapModularBlock(uids.image.blockUid, {
    [uids.image.file]: contentstackFileRefValue(assetUid, uids.fileRefShape),
  });
}

function videoAudioBlockPayload(
  uids: BlogBodyBlockUids,
  videoEntryUid: string
): Record<string, unknown> {
  const { videoAudio } = uids;
  return wrapModularBlock(videoAudio.blockUid, {
    [videoAudio.video]: contentstackEntryRefValue(
      videoEntryUid,
      videoAudio.refContentTypeUid,
      videoAudio.referenceShape
    ),
  });
}

function headingTextFields(
  uids: BlogBodyBlockUids,
  text: string,
  level: number
): Record<string, unknown> {
  return level <= uids.headingGroupMaxLevel
    ? { [uids.text.groupTitle]: text }
    : { [uids.text.subhead]: text };
}

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

function loadBodyLogMaxBytes(): number {
  const raw = process.env.BLOG_BODY_LOG_MAX_BYTES ?? process.env.MIGRATION_WP_EXTRACT_JSON_MAX_BYTES ?? "8000";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
}

function truncateJson(value: unknown, maxBytes: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= maxBytes ? s : `${s.slice(0, maxBytes)}…(${s.length} bytes total)`;
  } catch {
    return String(value);
  }
}

function truncateStringField(value: unknown, maxLen: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…(${value.length} chars total)`;
}

/** Shallow copy of `content` with long `rendered` / `raw` strings truncated for logs. */
export function contentAttributeForLog(content: unknown, maxFieldLen = 1200): unknown {
  if (content === undefined || content === null) return content;
  if (typeof content === "string") return truncateStringField(content, maxFieldLen);
  if (typeof content !== "object" || Array.isArray(content)) return content;

  const src = content as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const key of ["rendered", "raw", "protected"]) {
    if (key in out) out[key] = truncateStringField(out[key], maxFieldLen);
  }
  return out;
}

function previewBlockContent(value: unknown, max = 120): string | undefined {
  const s = pickString(value);
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Normalize REST `name`/`attributes` into `blockName`/`attrs` (+ synthetic innerHTML when needed). */
export function normalizeWpBlock(raw: WpContentBlock): WpContentBlock {
  const blockName = pickString(raw.blockName) || pickString(raw.name) || null;
  const attrs = { ...(raw.attributes ?? {}), ...(raw.attrs ?? {}) };
  const innerBlocks = (raw.innerBlocks ?? []).map(normalizeWpBlock);

  let innerHTML = raw.innerHTML?.trim() ?? "";
  const attrContent = pickString(attrs.content);
  if (!innerHTML && attrContent) {
    if (blockName === "core/paragraph") {
      innerHTML = /<[a-z][\s\S]*>/i.test(attrContent) ? attrContent : `<p>${attrContent}</p>`;
    } else if (blockName === "core/heading") {
      const level = pickPositiveInt(attrs.level) ?? 2;
      innerHTML = `<h${level}>${attrContent}</h${level}>`;
    } else {
      innerHTML = attrContent;
    }
  }

  return { blockName, attrs, innerBlocks, innerHTML: innerHTML || undefined };
}

/** Compact per-block summary for mapping discovery. */
export function summarizeWpBlocksForLog(blocks: WpContentBlock[]): unknown[] {
  const walk = (list: WpContentBlock[]): unknown[] =>
    list.map((b) => {
      const attrs = { ...(b.attributes ?? {}), ...(b.attrs ?? {}) };
      return {
        name: b.name ?? b.blockName ?? null,
        attributes_content: previewBlockContent(attrs.content),
        attributes_level: attrs.level,
        innerHTML_len: (b.innerHTML ?? "").length,
        innerBlocks_count: b.innerBlocks?.length ?? 0,
        innerBlocks: b.innerBlocks?.length ? walk(b.innerBlocks) : undefined,
      };
    });
  return walk(blocks);
}

/**
 * Log WordPress `content`, `content.blocks`, and other block sources for mapping verification.
 * Controlled by `BLOG_BODY_LOG_CONTENT=1` (default on).
 */
export function logWpStoryContentForMapping(wpId: number, story: Record<string, unknown>): void {
  if (process.env.BLOG_BODY_LOG_CONTENT === "0") return;

  const maxBytes = loadBodyLogMaxBytes();
  const content = story.content;

  console.error(
    `[blog] wp_id=${wpId} content attribute: ${truncateJson(contentAttributeForLog(content), maxBytes)}`
  );

  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentBlocks = (content as { blocks?: unknown }).blocks;
    if (contentBlocks === undefined) {
      console.error(`[blog] wp_id=${wpId} content.blocks: (missing)`);
    } else if (!Array.isArray(contentBlocks)) {
      console.error(
        `[blog] wp_id=${wpId} content.blocks: (not an array) ${truncateJson(contentBlocks, maxBytes)}`
      );
    } else if (contentBlocks.length === 0) {
      console.error(`[blog] wp_id=${wpId} content.blocks: []`);
    } else {
      console.error(
        `[blog] wp_id=${wpId} content.blocks summary: ${truncateJson(
          summarizeWpBlocksForLog(contentBlocks as WpContentBlock[]),
          maxBytes
        )}`
      );
      console.error(
        `[blog] wp_id=${wpId} content.blocks full: ${truncateJson(contentBlocks, maxBytes)}`
      );
    }
  } else {
    console.error(`[blog] wp_id=${wpId} content.blocks: (content is not an object)`);
  }

  const topBlocks = story.blocks;
  if (topBlocks !== undefined) {
    if (!Array.isArray(topBlocks)) {
      console.error(
        `[blog] wp_id=${wpId} story.blocks: (not an array) ${truncateJson(topBlocks, maxBytes)}`
      );
    } else if (topBlocks.length === 0) {
      console.error(`[blog] wp_id=${wpId} story.blocks: []`);
    } else {
      console.error(
        `[blog] wp_id=${wpId} story.blocks summary: ${truncateJson(
          summarizeWpBlocksForLog(topBlocks as WpContentBlock[]),
          maxBytes
        )}`
      );
      console.error(`[blog] wp_id=${wpId} story.blocks full: ${truncateJson(topBlocks, maxBytes)}`);
    }
  }

  const extracted = extractWpContentBlocks(story);
  const blockNames = extracted.map((b) => b.blockName ?? "(null)").join(", ") || "(none)";
  console.error(
    `[blog] wp_id=${wpId} extractWpContentBlocks: count=${extracted.length} names=[${blockNames}]`
  );
}

function normalizeWpBlockList(blocks: unknown[]): WpContentBlock[] {
  return blocks.map((b) => normalizeWpBlock(b as WpContentBlock));
}

/** Collect WP blocks from common REST shapes (`blocks`, `content.blocks`, Gutenberg raw). */
export function extractWpContentBlocks(story: Record<string, unknown>): WpContentBlock[] {
  const top = story.blocks;
  if (Array.isArray(top) && top.length > 0) {
    return normalizeWpBlockList(top);
  }

  const content = story.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentBlocks = (content as { blocks?: unknown }).blocks;
    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      return normalizeWpBlockList(contentBlocks);
    }
    const raw = pickRawContent(content);
    if (raw.includes("<!-- wp:")) {
      const parsed = parseGutenbergRawTopLevel(raw);
      if (parsed.length > 0) return parsed.map(normalizeWpBlock);
    }
  }

  const meta = story.meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const metaBlocks = (meta as { blocks?: unknown }).blocks;
    if (Array.isArray(metaBlocks) && metaBlocks.length > 0) {
      return normalizeWpBlockList(metaBlocks);
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

/** Hero / decorative blocks with no body text (e.g. `vmware/hero` → empty `article-hero` div). */
function isSkippedBlock(name: string): boolean {
  return (
    isLayoutBlock(name) ||
    name === "vmware/hero" ||
    name.endsWith("/hero") ||
    name === "core/post-featured-image"
  );
}

/** Walk `content.rendered` segments when block `attributes` are empty (common on VMware stories). */
class RenderedSegmentCursor {
  private idx = 0;

  constructor(private readonly segments: HtmlSegment[]) {}

  take(kind: "paragraph" | "heading"): HtmlSegment | undefined {
    while (this.idx < this.segments.length) {
      const seg = this.segments[this.idx]!;
      this.idx += 1;
      if (seg.kind === kind) return seg;
    }
    return undefined;
  }
}

export async function buildBodyContentFromWpStory(
  story: Record<string, unknown>,
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  sourceMode: BlogBodySource = "blocks_then_rendered",
  log?: (msg: string) => void,
  resolveVideo?: BodyVideoResolver
): Promise<BodyContentBuildResult> {
  const stats = {
    text: 0,
    image: 0,
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
    const renderedFallback = pickRenderedContent(story.content);
    const segmentCursor = renderedFallback
      ? new RenderedSegmentCursor(parseRenderedHtmlSegments(renderedFallback))
      : undefined;
    const blocks = await convertWpBlocks(
      wpBlocks,
      uids,
      resolveImage,
      resolveVideo,
      stats,
      log,
      segmentCursor
    );
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
      blocks.push(wrapModularBlock(uids.text.blockUid, headingTextFields(uids, text, seg.level)));
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
      const quoteHtml = author ? `<blockquote><p>${quote}</p><cite>${author}</cite></blockquote>` : `<p>${quote}</p>`;
      blocks.push(wrapModularBlock(uids.text.blockUid, { [uids.text.text]: stripUnsafeHtml(quoteHtml) }));
      stats.text += 1;
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
      blocks.push(imageBlockPayload(uids, assetUid));
      stats.image += 1;
    }
  }

  return { blocks, stats };
}

async function convertWpBlocks(
  wpBlocks: WpContentBlock[],
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  resolveVideo: BodyVideoResolver | undefined,
  stats: BodyContentBuildResult["stats"],
  log?: (msg: string) => void,
  segmentCursor?: RenderedSegmentCursor
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];

  for (const block of wpBlocks) {
    const converted = await convertOneWpBlock(
      block,
      uids,
      resolveImage,
      resolveVideo,
      stats,
      log,
      segmentCursor
    );
    out.push(...converted);
  }

  return out;
}

function paragraphHtmlFromBlock(
  block: WpContentBlock,
  segmentCursor?: RenderedSegmentCursor
): string {
  let html = stripUnsafeHtml(block.innerHTML ?? "");
  if (!html) {
    const content = pickString(block.attrs?.content);
    if (content) {
      html = /<[a-z][\s\S]*>/i.test(content) ? stripUnsafeHtml(content) : `<p>${content}</p>`;
    }
  }
  if (!html && segmentCursor) {
    const seg = segmentCursor.take("paragraph");
    if (seg?.kind === "paragraph") html = stripUnsafeHtml(seg.html);
  }
  return html;
}

function headingFromBlock(
  block: WpContentBlock,
  segmentCursor?: RenderedSegmentCursor
): { text: string; level: number } | undefined {
  let level = pickPositiveInt(block.attrs?.level) ?? 2;
  let text = pickString(block.attrs?.content) || stripTags(block.innerHTML ?? "");
  if (!text && segmentCursor) {
    const seg = segmentCursor.take("heading");
    if (seg?.kind === "heading") {
      text = stripTags(seg.html);
      level = seg.level;
    }
  }
  if (!text) return undefined;
  return { text, level };
}

async function convertOneWpBlock(
  block: WpContentBlock,
  uids: BlogBodyBlockUids,
  resolveImage: BodyImageResolver,
  resolveVideo: BodyVideoResolver | undefined,
  stats: BodyContentBuildResult["stats"],
  log?: (msg: string) => void,
  segmentCursor?: RenderedSegmentCursor
): Promise<Record<string, unknown>[]> {
  const normalized = normalizeWpBlock(block);
  const name = normalizeBlockName(normalized.blockName);
  const result: Record<string, unknown>[] = [];

  if (!name || isSkippedBlock(name)) {
    if (name && name !== "vmware/hero" && !name.endsWith("/hero")) {
      const inner = normalized.innerBlocks ?? [];
      const nested: Record<string, unknown>[] = [];
      for (const child of inner) {
        nested.push(
          ...(await convertOneWpBlock(
            child,
            uids,
            resolveImage,
            resolveVideo,
            stats,
            log,
            segmentCursor
          ))
        );
      }
      return nested;
    }
    if (name) log?.(`skipped block ${name}`);
    stats.skipped += 1;
    return [];
  }

  if (name === "core/paragraph" || name === "core/freeform") {
    const html = paragraphHtmlFromBlock(normalized, segmentCursor);
    if (!html) {
      stats.skipped += 1;
      log?.(`skipped core/paragraph (no content in attributes or rendered)`);
      return [];
    }
    outPushText(uids, { text: html }, stats, result);
    return result;
  }

  if (name === "core/heading") {
    const heading = headingFromBlock(normalized, segmentCursor);
    if (!heading) {
      stats.skipped += 1;
      log?.(`skipped core/heading (no content in attributes or rendered)`);
      return [];
    }
    result.push(
      wrapModularBlock(uids.text.blockUid, headingTextFields(uids, heading.text, heading.level))
    );
    stats.text += 1;
    return result;
  }

  if (name === "core/image") {
    const attachmentId = pickPositiveInt(normalized.attrs?.id);
    const imageUrl = pickString(normalized.attrs?.url);
    const caption = pickString(normalized.attrs?.caption) || pickString(normalized.attrs?.alt);
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
    result.push(imageBlockPayload(uids, assetUid));
    stats.image += 1;
    return result;
  }

  if (name === "core/media-text") {
    const attachmentId = pickPositiveInt(normalized.attrs?.mediaId);
    const imageUrl = pickString(normalized.attrs?.mediaUrl);
    const assetUid = await resolveImage({
      attachmentId,
      imageUrl,
      purpose: "body image (core/media-text)",
    });
    const textHtml = stripUnsafeHtml(
      (normalized.innerBlocks ?? [])
        .map((b) => paragraphHtmlFromBlock(normalizeWpBlock(b), segmentCursor))
        .join("")
        .trim() || normalized.innerHTML || ""
    );
    if (assetUid) {
      result.push(imageBlockPayload(uids, assetUid));
      stats.image += 1;
    }
    if (textHtml) {
      outPushText(uids, { text: textHtml }, stats, result);
    }
    if (!assetUid && !textHtml) {
      stats.skipped += 1;
    }
    return result;
  }

  if (name === "core/quote" || name === "core/pullquote") {
    const parsed = parseQuoteFromHtml(normalized.innerHTML ?? "");
    const quote =
      parsed.quote ||
      pickString(normalized.attrs?.value) ||
      pickString(normalized.attrs?.content) ||
      stripTags(normalized.innerHTML ?? "");
    const author = parsed.author || pickString(normalized.attrs?.citation);
    if (!quote) {
      stats.skipped += 1;
      return [];
    }
    const quoteHtml = author
      ? `<blockquote><p>${quote}</p><cite>${author}</cite></blockquote>`
      : `<p>${quote}</p>`;
    outPushText(uids, { text: stripUnsafeHtml(quoteHtml) }, stats, result);
    return result;
  }

  if (name === "core/embed" || name === "core/video") {
    const attachmentId = pickPositiveInt(normalized.attrs?.id);
    const embedUrl = pickString(normalized.attrs?.url) || pickString(normalized.attrs?.src);
    if (!resolveVideo) {
      stats.skipped += 1;
      log?.(`skipped ${name}: video resolver not configured`);
      return [];
    }
    const videoEntryUid = await resolveVideo({
      attachmentId,
      embedUrl,
      purpose: `body video (${name})`,
    });
    if (!videoEntryUid) {
      stats.skipped += 1;
      log?.(`skipped ${name}: no video entry for attachment=${attachmentId ?? "?"} url=${embedUrl || "(none)"}`);
      return [];
    }
    result.push(videoAudioBlockPayload(uids, videoEntryUid));
    stats.video += 1;
    return result;
  }

  // Unknown block: try attributes.content / innerHTML as text, else recurse inner blocks.
  const unknownText =
    pickString(normalized.attrs?.content) || stripUnsafeHtml(normalized.innerHTML ?? "");
  if (unknownText) {
    const html = /<[a-z][\s\S]*>/i.test(unknownText) ? stripUnsafeHtml(unknownText) : `<p>${unknownText}</p>`;
    outPushText(uids, { text: html }, stats, result);
    log?.(`mapped unknown block ${name} as text`);
    return result;
  }

  const inner = normalized.innerBlocks ?? [];
  if (inner.length > 0) {
    const nested: Record<string, unknown>[] = [];
    for (const child of inner) {
      nested.push(
        ...(await convertOneWpBlock(
          child,
          uids,
          resolveImage,
          resolveVideo,
          stats,
          log,
          segmentCursor
        ))
      );
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
