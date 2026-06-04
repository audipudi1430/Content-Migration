import type { BlogCategoryFieldUids } from "./blog-category-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import { setAuthorImageField, type ImageGroupFieldUids } from "./blog-author-payload.js";
import { setSeoSocialGroup, type SeoLogContext } from "./seo-social-payload.js";

/**
 * Category thumbnail field — delegates to `setAuthorImageField` (same CMA shape as `author_image`).
 * - `group` (default): `category_thumbnail: { file: "blt..." }`
 * - `global`: same nested shape under a Global field UID
 * - `file`: top-level file field
 */
export function setCategoryThumbnailField(
  entry: Record<string, unknown>,
  fields: BlogCategoryFieldUids,
  assetUid: string,
  mergeGroup?: Record<string, unknown>
): void {
  const imageFields: ImageGroupFieldUids = {
    authorImage: fields.categoryThumbnail,
    authorImageFileField: fields.categoryThumbnailFileField,
    authorImageLayout: fields.categoryThumbnailLayout,
    fileRefShape: fields.fileRefShape,
  };
  setAuthorImageField(entry, imageFields, assetUid, mergeGroup);
}

export function setCategorySeoGlobal(
  entry: Record<string, unknown>,
  fields: BlogCategoryFieldUids,
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

/** Contentstack reference entries: `[{ uid, _content_type_uid }]`. */
export function setCategorySubCategoryRefs(
  entry: Record<string, unknown>,
  fieldUid: string,
  refs: { uid: string; contentTypeUid: string }[]
): void {
  if (!fieldUid || refs.length === 0) return;
  entry[fieldUid] = refs.map((r) => ({
    uid: r.uid,
    _content_type_uid: r.contentTypeUid,
  }));
}
