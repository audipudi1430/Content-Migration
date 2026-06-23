import type { BlogFieldUids, BlogReferenceShape } from "./blog-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import { pickRenderedTitle } from "./blog-author-seo.js";
import {
  contentstackAssetRefValue,
  setAuthorImageField,
  type ImageGroupFieldUids,
} from "./blog-author-payload.js";
import { setSeoSocialGroup, type SeoLogContext } from "./seo-social-payload.js";
import { normalizeWpText } from "./contentstack-rte.js";

export { pickRenderedTitle };

/** CMA reference value for a single linked entry. */
export function contentstackEntryRefValue(
  uid: string,
  contentTypeUid: string,
  shape: BlogReferenceShape = "object"
): unknown {
  const ref = { uid, _content_type_uid: contentTypeUid };
  return shape === "array" ? [ref] : ref;
}

export function setEntryReference(
  entry: Record<string, unknown>,
  fieldUid: string,
  uid: string,
  contentTypeUid: string,
  shape: BlogReferenceShape = "object"
): void {
  if (!fieldUid || !uid || !contentTypeUid) return;
  entry[fieldUid] = contentstackEntryRefValue(uid, contentTypeUid, shape);
}

/** Multi-reference field (`ref_multiple: true`) — always an array of entry refs. */
export function setEntryReferences(
  entry: Record<string, unknown>,
  fieldUid: string,
  uids: string[],
  contentTypeUid: string
): void {
  if (!fieldUid || !contentTypeUid) return;
  const refs = uids
    .map((uid) => uid.trim())
    .filter(Boolean)
    .map((uid) => ({ uid, _content_type_uid: contentTypeUid }));
  if (refs.length === 0) return;
  entry[fieldUid] = refs;
}

export function setScalar(entry: Record<string, unknown>, fieldUid: string, value: unknown): void {
  if (!fieldUid) return;
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  entry[fieldUid] = value;
}

/** Body Content global field: `{ modular_blocks: [{ text: {...} }, ...] }`. */
export function setModularBodyField(
  entry: Record<string, unknown>,
  fieldUid: string,
  globalValue: Record<string, unknown>
): void {
  if (!fieldUid || !globalValue || Object.keys(globalValue).length === 0) return;
  entry[fieldUid] = globalValue;
}

/** Extract positive integer term IDs from WP REST taxonomy values (ids, objects, or strings). */
export function pickWpTermIds(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  const toId = (item: unknown): number | undefined => {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) return Math.floor(item);
    if (typeof item === "string") {
      const n = Number(item.trim());
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return undefined;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as { id?: unknown; term_id?: unknown }).id ?? (item as { term_id?: unknown }).term_id;
      if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.floor(id);
      if (typeof id === "string") {
        const n = Number(id.trim());
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
    return undefined;
  };

  if (Array.isArray(value)) {
    return value.map(toId).filter((n): n is number => n !== undefined);
  }
  const single = toId(value);
  return single !== undefined ? [single] : [];
}

export function pickMetaString(meta: Record<string, unknown> | undefined, key: string): string {
  if (!key || !meta) return "";
  const v = meta[key];
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return normalizeWpText(v);
  if (typeof v === "number" || typeof v === "boolean") return normalizeWpText(String(v));
  return "";
}

export type BuildBlogPayloadInput = {
  story: Record<string, unknown>;
  fields: BlogFieldUids;
  pageUrl: string;
  cmsTitle: string;
  categoryRefUids?: string[];
  categoryRefContentTypeUid: string;
  authorRefUids?: string[];
  authorRefContentTypeUid: string;
  seriesRefUid?: string;
  seriesRefContentTypeUid?: string;
  selectDefaults: { showInNewsroomLanding?: string; showInLatestBlogs?: string };
  metaKeys: {
    subHeader: string;
    shortLinkText: string;
    byline: string;
    blogTopics: string;
  };
};

export function buildBlogEntryPayload(input: BuildBlogPayloadInput): Record<string, unknown> {
  const {
    story,
    fields,
    pageUrl,
    cmsTitle,
    categoryRefUids,
    categoryRefContentTypeUid,
    authorRefUids,
    authorRefContentTypeUid,
    seriesRefUid,
    seriesRefContentTypeUid,
    selectDefaults,
    metaKeys,
  } = input;

  const meta =
    story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
      ? (story.meta as Record<string, unknown>)
      : undefined;

  const entry: Record<string, unknown> = {
    title: cmsTitle,
  };

  setScalar(entry, fields.cmsAssetName, cmsTitle);
  setScalar(entry, fields.url, pageUrl);
  setScalar(entry, fields.headline, cmsTitle);
  setScalar(entry, fields.subHeader, pickMetaString(meta, metaKeys.subHeader));
  setScalar(entry, fields.shortLinkText, cmsTitle);
  setScalar(entry, fields.dateline, new Date().toISOString());
  setScalar(entry, fields.byline, pickMetaString(meta, metaKeys.byline));
  setScalar(entry, fields.blogTopics, pickMetaString(meta, metaKeys.blogTopics));
  setScalar(entry, fields.showInNewsroomLanding, selectDefaults.showInNewsroomLanding);
  setScalar(entry, fields.showInLatestBlogs, selectDefaults.showInLatestBlogs);

  if (categoryRefUids && categoryRefUids.length > 0) {
    setEntryReferences(entry, fields.blogCategory, categoryRefUids, categoryRefContentTypeUid);
  }

  if (authorRefUids && authorRefUids.length > 0) {
    setEntryReferences(entry, fields.blogAuthorProfile, authorRefUids, authorRefContentTypeUid);
  }

  if (seriesRefUid && seriesRefContentTypeUid) {
    setEntryReference(
      entry,
      fields.seriesLabel,
      seriesRefUid,
      seriesRefContentTypeUid,
      fields.referenceShape
    );
  }

  return entry;
}

function mergeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type ThumbnailFieldOptions = {
  focalPoint?: { x: number; y: number };
};

/**
 * CMA value for Image Preset Picker inside `image_preset` global.
 * @see https://www.contentstack.com/docs/developers/marketplace-apps/image-preset-builder
 */
export function buildImagePresetPickerValue(
  assetUid: string,
  fields: Pick<
    BlogFieldUids,
    "thumbnailPresetExtensionUid" | "thumbnailPresetUid" | "thumbnailPresetName" | "fileRefShape"
  >,
  mergePreset?: Record<string, unknown>,
  options?: ThumbnailFieldOptions
): Record<string, unknown> {
  const presetUid = fields.thumbnailPresetUid.trim();
  const extensionUid = fields.thumbnailPresetExtensionUid.trim();

  const presetOptions: Record<string, unknown> = {};
  if (options?.focalPoint) {
    presetOptions["focal-point"] = {
      x: options.focalPoint.x,
      y: options.focalPoint.y,
    };
  }

  const preset: Record<string, unknown> = {
    "query-params": "",
  };
  if (presetUid) preset.uid = presetUid;
  if (fields.thumbnailPresetName) preset.name = fields.thumbnailPresetName;
  if (Object.keys(presetOptions).length > 0) preset.options = presetOptions;

  const metadata: Record<string, unknown> = {
    ...(extensionUid ? { extension_uid: extensionUid } : {}),
    preset,
  };

  const out: Record<string, unknown> = {
    ...mergePreset,
    uid: assetUid,
    _content_type_uid: "sys_assets",
    metadata,
  };
  if (presetUid) out.lookup = presetUid;
  if (extensionUid) out.extension_uid = extensionUid;
  return out;
}

/**
 * Article image global (`image_preset` nested under `article_image.image`).
 * Uses Image Preset Picker metadata when extension UID and/or focal point is present.
 */
export function setThumbnailField(
  entry: Record<string, unknown>,
  fields: BlogFieldUids,
  assetUid: string,
  mergeThumbnail?: Record<string, unknown>,
  options?: ThumbnailFieldOptions
): void {
  const presetField = fields.thumbnailImagePresetField;
  const imageField = fields.thumbnailPresetImageField;
  const mergePreset = mergeRecord(mergeThumbnail?.[presetField]);

  const usePresetPicker =
    Boolean(fields.thumbnailPresetExtensionUid.trim()) || Boolean(options?.focalPoint);

  const presetValue = usePresetPicker
    ? buildImagePresetPickerValue(assetUid, fields, mergePreset, options)
    : presetField === imageField
      ? contentstackAssetRefValue(assetUid, "object")
      : {
          ...mergePreset,
          [imageField]: contentstackAssetRefValue(assetUid, fields.fileRefShape),
        };

  entry[fields.thumbnail] = {
    ...mergeThumbnail,
    [presetField]: presetValue,
  };
}

/** Read focal point from an existing thumbnail Image Preset Picker value (for --update merges). */
export function pickExistingThumbnailFocalPoint(
  existingThumbnail: Record<string, unknown> | undefined,
  fields: Pick<BlogFieldUids, "thumbnailImagePresetField">
): ThumbnailFieldOptions["focalPoint"] | undefined {
  if (!existingThumbnail) return undefined;
  const preset = existingThumbnail[fields.thumbnailImagePresetField];
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) return undefined;
  const metadata = (preset as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const presetMeta = (metadata as Record<string, unknown>).preset;
  if (!presetMeta || typeof presetMeta !== "object" || Array.isArray(presetMeta)) return undefined;
  const options = (presetMeta as Record<string, unknown>).options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined;
  const fp = (options as Record<string, unknown>)["focal-point"];
  if (!fp || typeof fp !== "object" || Array.isArray(fp)) return undefined;
  const x = Number((fp as { x?: unknown }).x);
  const y = Number((fp as { y?: unknown }).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/**
 * Banner image field — delegates to `setAuthorImageField` (same CMA shape as `category_thumbnail`).
 * - `group` (default): `banner_image: { file: "blt..." }`
 */
export function setBannerImageField(
  entry: Record<string, unknown>,
  fields: BlogFieldUids,
  assetUid: string,
  mergeGroup?: Record<string, unknown>
): void {
  const imageFields: ImageGroupFieldUids = {
    authorImage: fields.bannerImage,
    authorImageFileField: fields.bannerImageFileField,
    authorImageLayout: fields.bannerImageLayout,
    fileRefShape: fields.fileRefShape,
  };
  setAuthorImageField(entry, imageFields, assetUid, mergeGroup);
}

/** WordPress `featured_media` attachment id from a story REST object. */
export function pickFeaturedMediaId(story: Record<string, unknown>): number | undefined {
  const v = story.featured_media;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

export function setBlogSeoGlobal(
  entry: Record<string, unknown>,
  fields: BlogFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGlobal?: Record<string, unknown>,
  metaImageAssetUid?: string,
  mergeMetaImageGroup?: Record<string, unknown>,
  logContext?: SeoLogContext
): void {
  setSeoSocialGroup(
    entry,
    fields,
    seo,
    metaDescription,
    mergeGlobal,
    metaImageAssetUid,
    mergeMetaImageGroup,
    logContext
  );
}
