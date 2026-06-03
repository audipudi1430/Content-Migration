import type { WpAuthorSeoData } from "./blog-author-seo.js";

/** Field UIDs for the SEO & Social group (shared by blog_author, blog_category, etc.). */
export type SeoSocialFieldUids = {
  seoSocialGroup: string;
  seoTitleTag: string;
  seoPageUrl: string;
  seoPageUrlInnerUrl: string;
  seoPageUrlInnerStatus: string;
  seoPageUrlStatusDefault: string;
  seoCanonical: string;
  metaDescription: string;
};

/**
 * SEO & Social group: title tag, page URL row(s), canonical, meta description (plain string).
 */
export function setSeoSocialGroup(
  entry: Record<string, unknown>,
  fields: SeoSocialFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGroup?: Record<string, unknown>,
  extras?: Record<string, unknown>
): void {
  const group: Record<string, unknown> = { ...mergeGroup, ...extras };

  group[fields.metaDescription] = metaDescription;

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

  entry[fields.seoSocialGroup] = group;
}
