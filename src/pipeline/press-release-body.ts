/**
 * Build press_release `body` HTML from WordPress story JSON (blocks or rendered).
 * Skips hero/image/video blocks — press releases do not use article_image.
 */
import {
  decodeHtmlEntities,
  sanitizeBodyHtmlForContentstack,
} from "./contentstack-rte.js";

type WpBlock = {
  name?: string;
  attributes?: Record<string, unknown>;
  innerBlocks?: WpBlock[];
};

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function skipBlock(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("hero") ||
    n === "core/image" ||
    n === "core/gallery" ||
    n === "core/video" ||
    n === "core/embed" ||
    n === "core/audio" ||
    n === "core/cover" ||
    n === "core/media-text"
  );
}

function headingTag(level: unknown): string {
  const n = Number(level);
  if (Number.isFinite(n) && n >= 1 && n <= 6) return `h${Math.floor(n)}`;
  return "h2";
}

function renderListItem(block: WpBlock): string {
  const content = pickString(block.attributes?.content);
  const inner = (block.innerBlocks ?? []).map(renderBlock).join("");
  return `<li>${content}${inner}</li>`;
}

function renderBlock(block: WpBlock): string {
  const name = pickString(block.name);
  if (!name || skipBlock(name)) return "";

  const attrs = block.attributes ?? {};

  if (name === "core/paragraph") {
    const content = pickString(attrs.content);
    if (!content) return "";
    return `<p>${content}</p>`;
  }

  if (name === "core/heading") {
    const content = pickString(attrs.content);
    if (!content) return "";
    const tag = headingTag(attrs.level);
    return `<${tag}>${content}</${tag}>`;
  }

  if (name === "core/list") {
    const ordered = Boolean(attrs.ordered);
    const tag = ordered ? "ol" : "ul";
    const items = (block.innerBlocks ?? [])
      .filter((b) => pickString(b.name) === "core/list-item")
      .map(renderListItem)
      .join("");
    const values = pickString(attrs.values);
    if (!items && values) return `<${tag}>${values}</${tag}>`;
    if (!items) return "";
    return `<${tag}>${items}</${tag}>`;
  }

  if (name === "core/list-item") {
    return renderListItem(block);
  }

  if (name === "core/quote") {
    const value = pickString(attrs.value) || pickString(attrs.content);
    const cite = pickString(attrs.citation);
    const inner = (block.innerBlocks ?? []).map(renderBlock).join("");
    const body = value || inner;
    if (!body) return "";
    return cite ? `<blockquote>${body}<cite>${cite}</cite></blockquote>` : `<blockquote>${body}</blockquote>`;
  }

  if (name === "core/html") {
    return pickString(attrs.html) || pickString(attrs.content);
  }

  // Unknown containers: recurse inner blocks
  const inner = (block.innerBlocks ?? []).map(renderBlock).join("");
  return inner;
}

function stripHeroFromRendered(html: string): string {
  return html
    .replace(/<div\b[^>]*class="[^"]*article-hero[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/^\s+/, "");
}

function collapseWhitespaceBetweenBlocks(html: string): string {
  return html.replace(/>\s+</g, "><").trim();
}

/** Prefer Gutenberg blocks; fall back to `content.rendered` with hero stripped. */
export function buildPressReleaseBodyHtml(story: Record<string, unknown>): string {
  const content =
    story.content && typeof story.content === "object" && !Array.isArray(story.content)
      ? (story.content as Record<string, unknown>)
      : undefined;

  const blocksRaw = content?.blocks;
  if (Array.isArray(blocksRaw) && blocksRaw.length > 0) {
    const html = (blocksRaw as WpBlock[]).map(renderBlock).join("");
    const cleaned = sanitizeBodyHtmlForContentstack(decodeHtmlEntities(html));
    if (cleaned.trim()) return collapseWhitespaceBetweenBlocks(cleaned);
  }

  const rendered = pickString(content?.rendered);
  if (rendered) {
    const stripped = stripHeroFromRendered(rendered);
    return collapseWhitespaceBetweenBlocks(
      sanitizeBodyHtmlForContentstack(decodeHtmlEntities(stripped))
    );
  }

  return "";
}
