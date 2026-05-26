/**
 * Build Contentstack JSON Rich Text Editor payload for Management API.
 * @see https://www.contentstack.com/docs/developers/apis/content-management-api/#json-rich-text-editor
 */

function stripUnsafeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .trim();
}

function htmlToPlainWithBreaks(html: string): string {
  return stripUnsafeHtml(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<\/div>\s*/gi, "\n\n")
    .replace(/<\/li>\s*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * Convert WordPress author `description` (plain text or HTML) to JSON RTE `doc` root.
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

/** Pick description string from WP REST (string or `{ rendered }`). */
export function pickWordPressDescriptionField(description: unknown): string {
  if (typeof description === "string") return description.trim();
  if (description && typeof description === "object" && "rendered" in description) {
    return String((description as { rendered?: string }).rendered ?? "").trim();
  }
  return "";
}
