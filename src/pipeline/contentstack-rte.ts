/**
 * Build Contentstack Rich Text payloads for Management API.
 * @see https://www.contentstack.com/docs/developers/json-rich-text-editor/schema-of-json-rich-text-editor
 */
import { randomBytes } from "node:crypto";

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

function codePointToChar(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * Decode WordPress HTML entities (`&#8211;`, `&ndash;`, etc.) to Unicode characters.
 * Safe to run on plain text or HTML fragments.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input) return input;

  let out = input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointToChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointToChar(parseInt(dec, 10)));

  out = out.replace(/&([a-z]+);/gi, (match, name: string) => {
    const decoded = HTML_NAMED_ENTITIES[name.toLowerCase()];
    return decoded ?? match;
  });

  return out;
}

/** Normalize WP text fields: decode entities and trim. */
export function normalizeWpText(input: string): string {
  return decodeHtmlEntities(input).trim();
}

export function stripUnsafeHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .trim()
  );
}

/** Plain text from WP HTML (for Text / Multi-line fields). */
export function htmlToPlainWithBreaks(html: string): string {
  return decodeHtmlEntities(
    stripUnsafeHtml(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*/gi, "\n\n")
      .replace(/<\/div>\s*/gi, "\n\n")
      .replace(/<\/li>\s*/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function rteNodeUid(): string {
  return randomBytes(16).toString("hex");
}

/** Contentstack JSON RTE blocks expect a `uid` on doc and block nodes. */
export function assignJsonRteUids(node: Record<string, unknown>): Record<string, unknown> {
  const out = { ...node };
  if (typeof out.type === "string" && !out.uid) {
    out.uid = rteNodeUid();
  }
  if (Array.isArray(out.children)) {
    out.children = out.children.map((child) => {
      if (child && typeof child === "object" && "type" in child) {
        return assignJsonRteUids(child as Record<string, unknown>);
      }
      return child;
    });
  }
  return out;
}

function paragraphNodes(text: string): { type: string; attrs: Record<string, never>; children: { text: string }[] }[] {
  const blocks = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const list = blocks.length > 0 ? blocks : text.trim() ? [text.trim()] : [];
  return list.map((block) => ({
    type: "p",
    attrs: {},
    children: [{ text: block.replace(/\n/g, " ") }],
  }));
}

/**
 * JSON RTE `doc` root (without array wrapper). Use `wordpressDescriptionToJsonRteFieldValue` for CMA entry body.
 */
export function wordpressDescriptionToJsonRte(htmlOrText: string): Record<string, unknown> | undefined {
  const raw = htmlOrText?.trim();
  if (!raw) return undefined;

  const hasHtml = /<[a-z][\s\S]*>/i.test(raw);
  const plain = hasHtml ? htmlToPlainWithBreaks(raw) : normalizeWpText(raw);
  if (!plain) return undefined;

  return {
    type: "doc",
    attrs: {},
    children: paragraphNodes(plain),
  };
}

/**
 * Value for a Contentstack **JSON Rich Text Editor** field on create/update.
 * CMA stores this as an array of doc roots, each with block `uid`s.
 */
export function wordpressDescriptionToJsonRteFieldValue(htmlOrText: string): Record<string, unknown>[] | undefined {
  const doc = wordpressDescriptionToJsonRte(htmlOrText);
  if (!doc) return undefined;
  return [assignJsonRteUids(doc)];
}

/** Pick description string from WP REST (string or `{ rendered }`). */
export function pickWordPressDescriptionField(description: unknown): string {
  if (typeof description === "string") return normalizeWpText(description);
  if (description && typeof description === "object" && "rendered" in description) {
    return normalizeWpText(String((description as { rendered?: string }).rendered ?? ""));
  }
  return "";
}
