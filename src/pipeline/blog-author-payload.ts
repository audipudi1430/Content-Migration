import type { BlogAuthorFieldUids } from "./blog-author-config.js";
import {
  htmlToPlainWithBreaks,
  pickWordPressDescriptionField,
  stripUnsafeHtml,
  wordpressDescriptionToJsonRteFieldValue,
} from "./contentstack-rte.js";

/** Contentstack single-file field: `[{ uid }]`. */
export function setFileAssetRef(entry: Record<string, unknown>, fieldUid: string, assetUid: string): void {
  entry[fieldUid] = [{ uid: assetUid }];
}

/**
 * Author image as a Global field: nested file reference inside the global module.
 * Example: `author_image: { image: [{ uid: "blt..." }] }`
 */
export function setGlobalFieldFileAssetRef(
  entry: Record<string, unknown>,
  globalFieldUid: string,
  innerFileFieldUid: string,
  assetUid: string
): void {
  entry[globalFieldUid] = {
    [innerFileFieldUid]: [{ uid: assetUid }],
  };
}

export function setAuthorImageField(
  entry: Record<string, unknown>,
  fields: BlogAuthorFieldUids,
  assetUid: string
): void {
  if (fields.authorImageIsGlobal) {
    setGlobalFieldFileAssetRef(entry, fields.authorImage, fields.authorImageGlobalInnerField, assetUid);
  } else {
    setFileAssetRef(entry, fields.authorImage, assetUid);
  }
}

export type BlogAuthorDescriptionFormat = "html" | "text" | "json_rte";

/**
 * How to map WP `description` onto the Contentstack field (must match field type in the stack):
 * - `html` — Classic Rich Text Editor (HTML string). **Default.**
 * - `text` — Text / Multi-line Text (plain string, tags stripped).
 * - `json_rte` — JSON Rich Text Editor (array of doc objects with block uids).
 */
export function loadBlogAuthorDescriptionFormat(): BlogAuthorDescriptionFormat {
  const raw = (process.env.BLOG_AUTHOR_DESCRIPTION_FORMAT ?? "html").toLowerCase();
  if (raw === "json_rte" || raw === "json-rte") return "json_rte";
  if (raw === "text" || raw === "string" || raw === "plain") return "text";
  return "html";
}

export type AuthorDescriptionMappingLog = {
  fieldUid: string;
  format: BlogAuthorDescriptionFormat;
  wpRawLength: number;
  wpPreview: string;
  set: boolean;
  payloadType?: string;
  payloadPreview?: string;
};

function previewString(s: string, max = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function previewPayload(value: unknown, max = 400): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= max ? s : `${s.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

/**
 * Map WordPress author description onto the Contentstack entry field.
 * Returns diagnostics for console logging (see migrate-blog-authors).
 */
export function setAuthorDescription(
  entry: Record<string, unknown>,
  fieldUid: string,
  description: unknown,
  format: BlogAuthorDescriptionFormat = loadBlogAuthorDescriptionFormat()
): AuthorDescriptionMappingLog {
  const raw = pickWordPressDescriptionField(description);
  const log: AuthorDescriptionMappingLog = {
    fieldUid,
    format,
    wpRawLength: raw.length,
    wpPreview: previewString(raw),
    set: false,
  };

  if (!raw) return log;

  if (format === "html") {
    entry[fieldUid] = stripUnsafeHtml(raw);
    log.set = true;
    log.payloadType = "string (html)";
    log.payloadPreview = previewString(String(entry[fieldUid]));
    return log;
  }

  if (format === "text") {
    const hasHtml = /<[a-z][\s\S]*>/i.test(raw);
    entry[fieldUid] = hasHtml ? htmlToPlainWithBreaks(raw) : raw;
    log.set = true;
    log.payloadType = "string (plain)";
    log.payloadPreview = previewString(String(entry[fieldUid]));
    return log;
  }

  const rte = wordpressDescriptionToJsonRteFieldValue(raw);
  if (rte) {
    entry[fieldUid] = rte;
    log.set = true;
    log.payloadType = "json_rte[]";
    log.payloadPreview = previewPayload(rte);
  }
  return log;
}
