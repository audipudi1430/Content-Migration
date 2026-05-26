import type { BlogAuthorFieldUids } from "./blog-author-config.js";
import { pickWordPressDescriptionField, wordpressDescriptionToJsonRte } from "./contentstack-rte.js";

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

/**
 * Description for Contentstack RTE (`json_rte`) or plain string (`html` legacy).
 */
export function setAuthorDescription(
  entry: Record<string, unknown>,
  fieldUid: string,
  description: unknown
): void {
  const raw = pickWordPressDescriptionField(description);
  if (!raw) return;

  const format = (process.env.BLOG_AUTHOR_DESCRIPTION_FORMAT ?? "json_rte").toLowerCase();
  if (format === "html" || format === "string") {
    entry[fieldUid] = raw;
    return;
  }

  const rte = wordpressDescriptionToJsonRte(raw);
  if (rte) entry[fieldUid] = rte;
}
