import type { BlogCategoryFieldUids } from "./blog-category-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import { setFileAssetRef, setGroupFileAssetRef } from "./blog-author-payload.js";
import { setSeoSocialGroup } from "./seo-social-payload.js";

export function setCategoryThumbnailField(
  entry: Record<string, unknown>,
  fields: BlogCategoryFieldUids,
  assetUid: string,
  mergeGroup?: Record<string, unknown>
): void {
  const shape = fields.fileRefShape;
  if (fields.categoryThumbnailLayout === "file") {
    setFileAssetRef(entry, fields.categoryThumbnail, assetUid, shape);
    return;
  }
  setGroupFileAssetRef(
    entry,
    fields.categoryThumbnail,
    fields.categoryThumbnailFileField,
    assetUid,
    shape,
    mergeGroup
  );
}

export function setCategorySeoGlobal(
  entry: Record<string, unknown>,
  fields: BlogCategoryFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGlobal?: Record<string, unknown>,
  metaImageAssetUid?: string,
  mergeMetaImageGroup?: Record<string, unknown>
): void {
  setSeoSocialGroup(
    entry,
    fields,
    seo,
    metaDescription,
    mergeGlobal,
    metaImageAssetUid,
    mergeMetaImageGroup
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
