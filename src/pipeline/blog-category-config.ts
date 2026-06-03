import type { FileRefShape } from "./blog-author-config.js";
import { loadBlogAuthorFileRefShape } from "./blog-author-config.js";
import type { MetaDescriptionSource } from "./blog-author-seo.js";
import type { SeoSocialFieldUids } from "./seo-social-payload.js";

/**
 * Blog category (`blog_category`) field UIDs and URL pattern.
 *
 * URL: `/{language}/category/{slug}` — see `blogCategoryPageUrlPath`.
 */
export type BlogCategoryFieldUids = SeoSocialFieldUids & {
  cmsAssetName: string;
  url: string;
  blogCategoryName: string;
  categoryThumbnail: string;
  categoryThumbnailFileField: string;
  categoryThumbnailLayout: "group" | "file";
  categoryNameAlias: string;
  /** Reference / modular field for child categories (optional). */
  blogSubCategories: string;
  metaImage: string;
  /** `name` = category name; `wp_seo` = Yoast/meta description when present. */
  metaDescriptionSource: MetaDescriptionSource;
  fileRefShape: FileRefShape;
};

export function loadBlogCategoryMetaDescriptionSource(): MetaDescriptionSource {
  return (process.env.BLOG_CATEGORY_META_DESCRIPTION_SOURCE ?? "name").toLowerCase() === "wp_seo"
    ? "wp_seo"
    : "name";
}

export function loadBlogCategoryContentTypeUid(): string {
  return (
    process.env.MIGRATION_CONTENT_TYPE_UID?.trim() ||
    process.env.CS_CONTENT_TYPE_BLOG_CATEGORY?.trim() ||
    "blog_category"
  );
}

/** Language path segment for category URLs (e.g. `en` → `/en/category/slug`). */
export function loadBlogCategoryUrlLanguage(): string {
  const explicit = process.env.BLOG_CATEGORY_URL_LANGUAGE?.trim();
  if (explicit) return explicit.replace(/^\/+|\/+$/g, "");
  const locale = process.env.CONTENTSTACK_LOCALE?.trim() || "en-us";
  const part = locale.split("-")[0];
  return part || "en";
}

/**
 * Public path: `/{language}/category/{slug}`.
 * Template override: `BLOG_CATEGORY_URL_TEMPLATE` with `{language}` and `{slug}`.
 */
export function blogCategoryPageUrlPath(slug: string, language?: string): string {
  const lang = (language ?? loadBlogCategoryUrlLanguage()).replace(/^\/+|\/+$/g, "");
  const s = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  const template =
    process.env.BLOG_CATEGORY_URL_TEMPLATE?.trim() || "/{language}/category/{slug}";
  return template
    .replace(/\{language\}/g, lang)
    .replace(/\{slug\}/g, s || "")
    .replace(/\/+/g, "/")
    .replace(/^(?!\/)/, "/");
}

function loadThumbnailLayout(): "group" | "file" {
  const layout = (process.env.BLOG_CATEGORY_THUMBNAIL_LAYOUT ?? "file").toLowerCase();
  return layout === "group" ? "group" : "file";
}

export function loadBlogCategoryFieldUids(): BlogCategoryFieldUids {
  const thumbFile =
    process.env.BLOG_CATEGORY_THUMBNAIL_FILE_FIELD?.trim() || "file";

  return {
    cmsAssetName: process.env.BLOG_CATEGORY_FIELD_CMS_ASSET_NAME ?? "cms_asset_name",
    url: process.env.BLOG_CATEGORY_FIELD_URL ?? "url",
    blogCategoryName: process.env.BLOG_CATEGORY_FIELD_BLOG_CATEGORY_NAME ?? "blog_category_name",
    categoryThumbnail: process.env.BLOG_CATEGORY_FIELD_CATEGORY_THUMBNAIL ?? "category_thumbnail",
    categoryThumbnailFileField: thumbFile,
    categoryThumbnailLayout: loadThumbnailLayout(),
    categoryNameAlias: process.env.BLOG_CATEGORY_FIELD_CATEGORY_NAME_ALIAS ?? "category_name_alias",
    blogSubCategories:
      process.env.BLOG_CATEGORY_FIELD_BLOG_SUB_CATEGORIES ?? "blog_sub_category",
    seoSocialGroup: process.env.BLOG_CATEGORY_FIELD_SEO_SOCIAL_GROUP ?? "seo",
    seoTitleTag: process.env.BLOG_CATEGORY_FIELD_SEO_TITLE_TAG ?? "seo_title_tag",
    seoPageUrl: process.env.BLOG_CATEGORY_FIELD_SEO_PAGE_URL ?? "page_url",
    seoPageUrlInnerUrl: process.env.BLOG_CATEGORY_FIELD_SEO_PAGE_URL_URL ?? "url",
    seoPageUrlInnerStatus: process.env.BLOG_CATEGORY_FIELD_SEO_PAGE_URL_STATUS ?? "status",
    seoPageUrlStatusDefault: process.env.BLOG_CATEGORY_SEO_PAGE_URL_STATUS_DEFAULT ?? "200",
    seoCanonical: process.env.BLOG_CATEGORY_FIELD_SEO_CANONICAL ?? "canonical",
    metaDescription: process.env.BLOG_CATEGORY_FIELD_META_DESCRIPTION ?? "meta_description",
    metaImage: process.env.BLOG_CATEGORY_FIELD_META_IMAGE ?? "meta_image",
    metaDescriptionSource: loadBlogCategoryMetaDescriptionSource(),
    fileRefShape: loadBlogAuthorFileRefShape(),
  };
}
