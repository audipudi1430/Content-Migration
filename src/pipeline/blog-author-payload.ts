import type { BlogAuthorFieldUids, FileRefShape } from "./blog-author-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import {
  htmlToPlainWithBreaks,
  pickWordPressDescriptionField,
  stripUnsafeHtml,
  wordpressDescriptionToJsonRteFieldValue,
} from "./contentstack-rte.js";

/**
 * CMA file reference for create/update entry.
 * @see https://www.contentstack.com/docs/developers/apis/content-management-api
 */
export function contentstackFileRefValue(assetUid: string, shape: FileRefShape = "uid"): unknown {
  switch (shape) {
    case "uid_array":
      return [assetUid];
    case "object":
      return { uid: assetUid };
    case "object_array":
      return [{ uid: assetUid }];
    default:
      return assetUid;
  }
}

export function setFileAssetRef(
  entry: Record<string, unknown>,
  fieldUid: string,
  assetUid: string,
  shape: FileRefShape = "uid"
): void {
  entry[fieldUid] = contentstackFileRefValue(assetUid, shape);
}

/** Nested file inside a Group or Global: `{ file: "blt..." }` (CMA default). */
export function setGroupFileAssetRef(
  entry: Record<string, unknown>,
  groupFieldUid: string,
  innerFileFieldUid: string,
  assetUid: string,
  shape: FileRefShape = "uid",
  mergeGroup?: Record<string, unknown>
): void {
  entry[groupFieldUid] = {
    ...mergeGroup,
    [innerFileFieldUid]: contentstackFileRefValue(assetUid, shape),
  };
}

/**
 * Author Image field on the content type.
 * - `group` (default): `author_image: { file: "blt..." }` (CMA single file UID string)
 * - `global`: same nested shape under a Global field UID
 * - `file`: top-level file field
 */
export function setAuthorImageField(
  entry: Record<string, unknown>,
  fields: BlogAuthorFieldUids,
  assetUid: string,
  mergeGroup?: Record<string, unknown>
): void {
  const inner = fields.authorImageFileField;
  const shape = fields.fileRefShape;
  if (fields.authorImageLayout === "file") {
    setFileAssetRef(entry, fields.authorImage, assetUid, shape);
    return;
  }
  setGroupFileAssetRef(entry, fields.authorImage, inner, assetUid, shape, mergeGroup);
}

/**
 * SEO & Social group: title tag, page URL row(s), canonical, meta description.
 */
export function setSeoSocialGroup(
  entry: Record<string, unknown>,
  fields: BlogAuthorFieldUids,
  seo: WpAuthorSeoData,
  opts: { metaDescription: string }
): void {
  const metaDesc =
    fields.metaDescriptionSource === "wp_seo" && seo.metaDescription
      ? seo.metaDescription
      : opts.metaDescription;

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
