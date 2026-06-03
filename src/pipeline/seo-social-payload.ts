import type { FileRefShape } from "./blog-author-config.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";

/** Field UIDs inside the `seo` Global field (blog_author, blog_category). */
export type SeoSocialFieldUids = {
  /** Global field UID on the content type (e.g. `seo`). */
  seoSocialGroup: string;
  /** SEO title inside global (e.g. `title`, not `seo_title_tag`). */
  seoTitle: string;
  /** Page URL field (e.g. `page_url`). */
  seoPageUrl: string;
  /** `string` = path text; `modular` = `[{ url, status }]`. */
  seoPageUrlShape: "string" | "modular";
  seoPageUrlInnerUrl: string;
  seoPageUrlInnerStatus: string;
  seoPageUrlStatusDefault: string;
  /** Optional; omit from payload when empty. */
  seoCanonical: string;
  metaDescription: string;
  /** Group inside global holding the file reference (e.g. `meta_image`). */
  metaImageGroup: string;
  metaImageFileField: string;
  fileRefShape: FileRefShape;
};

export function setSeoMetaImageInGlobal(
  group: Record<string, unknown>,
  fields: Pick<SeoSocialFieldUids, "metaImageGroup" | "metaImageFileField" | "fileRefShape">,
  assetUid: string,
  mergeMetaImageGroup?: Record<string, unknown>
): void {
  group[fields.metaImageGroup] = {
    ...mergeMetaImageGroup,
    [fields.metaImageFileField]: contentstackFileRefValue(assetUid, fields.fileRefShape),
  };
}

/**
 * Populate the `seo` Global field: title, page_url, meta_description, meta_image.file.
 */
export function setSeoSocialGroup(
  entry: Record<string, unknown>,
  fields: SeoSocialFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGroup?: Record<string, unknown>,
  metaImageAssetUid?: string,
  mergeMetaImageGroup?: Record<string, unknown>
): void {
  const group: Record<string, unknown> = { ...mergeGroup };

  group[fields.metaDescription] = metaDescription;

  if (seo.seoTitleTag) {
    group[fields.seoTitle] = seo.seoTitleTag;
  }

  if (seo.pageUrlPath) {
    if (fields.seoPageUrlShape === "modular") {
      group[fields.seoPageUrl] = [
        {
          [fields.seoPageUrlInnerUrl]: seo.pageUrlPath,
          [fields.seoPageUrlInnerStatus]: fields.seoPageUrlStatusDefault,
        },
      ];
    } else {
      group[fields.seoPageUrl] = seo.pageUrlPath;
    }
  }

  if (fields.seoCanonical && seo.canonicalPath) {
    group[fields.seoCanonical] = seo.canonicalPath;
  }

  if (metaImageAssetUid) {
    setSeoMetaImageInGlobal(group, fields, metaImageAssetUid, mergeMetaImageGroup);
  }

  entry[fields.seoSocialGroup] = group;
}
