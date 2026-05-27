import type { BlogAuthorFieldUids } from "./blog-author-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
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

/** Nested file inside a Group or Global: `{ file: [{ uid }] }`. */
export function setGroupFileAssetRef(
  entry: Record<string, unknown>,
  groupFieldUid: string,
  innerFileFieldUid: string,
  assetUid: string
): void {
  entry[groupFieldUid] = {
    [innerFileFieldUid]: [{ uid: assetUid }],
  };
}

/**
 * Author Image field on the content type.
 * - `group` (default): `author_image: { file: [{ uid }] }`
 * - `global`: same nested shape under a Global field UID
 * - `file`: top-level file field `author_image: [{ uid }]`
 */
export function setAuthorImageField(
  entry: Record<string, unknown>,
  fields: BlogAuthorFieldUids,
  assetUid: string
): void {
  const inner = fields.authorImageFileField;
  if (fields.authorImageLayout === "file") {
    setFileAssetRef(entry, fields.authorImage, assetUid);
    return;
  }
  setGroupFileAssetRef(entry, fields.authorImage, inner, assetUid);
}

/**
 * SEO & Social group: title tag, page URL row(s), canonical, meta description.
 */
export function setSeoSocialGroup(
  entry: Record<string, unknown>,
  fields: BlogAuthorFieldUids,
  seo: WpAuthorSeoData,
  entryTitle: string
): void {
  const metaDesc =
    fields.metaDescriptionSource === "wp_seo" && seo.metaDescription
      ? seo.metaDescription
      : entryTitle;

  const group: Record<string, unknown> = {};

  if (seo.seoTitleTag) {
    group[fields.seoTitleTag] = seo.seoTitleTag;
  }
  if (seo.pageUrlPath) {
    group[fields.seoPageUrl] = [
      {
        [fields.seoPageUrlInnerUrl]: seo.pageUrlPath,
        [fields.seoPageUrlInnerStatus]: fields.seoPageUrlStatusDefault,
      },
    ];
  }
  if (seo.canonicalPath) {
    group[fields.seoCanonical] = seo.canonicalPath;
  }
  if (metaDesc) {
    group[fields.metaDescription] = metaDesc;
  }

  if (Object.keys(group).length > 0) {
    entry[fields.seoSocialGroup] = group;
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
