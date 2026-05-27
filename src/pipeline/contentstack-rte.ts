/**
 * Build Contentstack Rich Text payloads for Management API.
 * @see https://www.contentstack.com/docs/developers/json-rich-text-editor/schema-of-json-rich-text-editor
 */
import { randomBytes } from "node:crypto";

export function stripUnsafeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .trim();
}

/** Plain text from WP HTML (for Text / Multi-line fields). */
export function htmlToPlainWithBreaks(html: string): string {
  return stripUnsafeHtml(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<\/div>\s*/gi, "\n\n")
    .replace(/<\/li>\s*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const plain = hasHtml ? htmlToPlainWithBreaks(raw) : raw;
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
  if (typeof description === "string") return description.trim();
  if (description && typeof description === "object" && "rendered" in description) {
    return String((description as { rendered?: string }).rendered ?? "").trim();
  }
  return "";
}
