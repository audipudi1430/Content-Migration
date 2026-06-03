import type { BlogCategoryFieldUids } from "./blog-category-config.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import {
  contentstackFileRefValue,
  setFileAssetRef,
  setGroupFileAssetRef,
} from "./blog-author-payload.js";
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

export function setCategorySeoSocialGroup(
  entry: Record<string, unknown>,
  fields: BlogCategoryFieldUids,
  seo: WpAuthorSeoData,
  categoryName: string,
  mergeGroup?: Record<string, unknown>,
  metaImageAssetUid?: string
): void {
  const extras: Record<string, unknown> = {};
  if (metaImageAssetUid) {
    extras[fields.metaImage] = contentstackFileRefValue(metaImageAssetUid, fields.fileRefShape);
  }
  setSeoSocialGroup(entry, fields, seo, categoryName, mergeGroup, extras);
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
