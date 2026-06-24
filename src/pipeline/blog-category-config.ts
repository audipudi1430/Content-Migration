import type { FileRefShape } from "./blog-author-config.js";
import { loadBlogAuthorFileRefShape } from "./blog-author-config.js";
import type { MetaDescriptionSource } from "./blog-author-seo.js";
import type { SeoSocialFieldUids } from "./seo-social-payload.js";
import {
  loadSharedSeoInnerFieldUids,
  loadSharedSeoPageUrlFields,
  resolveSeoPageUrlShape,
} from "./seo-social-payload.js";

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
  /** Nested file field UID inside category thumbnail group/global (`file` in your stack). */
  categoryThumbnailFileField: string;
  categoryThumbnailLayout: CategoryThumbnailLayout;
  categoryNameAlias: string;
  /** `show_url` dropdown: Yes / No from sheet `Is Page`. */
  showUrl: string;
  /** `category_level` from sheet `Level` (L1 → level1, etc.). */
  categoryLevel: string;
  /** Optional display `name` field (defaults to `blog_category_name` UID if unset). */
  categoryName: string;
  /** Reference / modular field for child categories (optional). */
  blogSubCategories: string;
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

/** How category_thumbnail is modeled on the content type (same options as author_image). */
export type CategoryThumbnailLayout = "group" | "global" | "file";

function loadThumbnailLayout(): CategoryThumbnailLayout {
  const layout = (process.env.BLOG_CATEGORY_THUMBNAIL_LAYOUT ?? "").toLowerCase();
  if (layout === "group" || layout === "global" || layout === "file") return layout;
  if (process.env.BLOG_CATEGORY_THUMBNAIL_IS_GLOBAL === "1") return "global";
  if (process.env.BLOG_CATEGORY_THUMBNAIL_IS_GLOBAL === "0") return "group";
  return "group";
}

function loadSeoPageUrlShape() {
  return resolveSeoPageUrlShape(process.env.BLOG_CATEGORY_SEO_PAGE_URL_SHAPE, "canonical_url_list");
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
    showUrl: process.env.BLOG_CATEGORY_FIELD_SHOW_URL ?? "show_url",
    categoryLevel: process.env.BLOG_CATEGORY_FIELD_CATEGORY_LEVEL ?? "category_level",
    categoryName:
      process.env.BLOG_CATEGORY_FIELD_NAME?.trim() ||
      process.env.BLOG_CATEGORY_FIELD_BLOG_CATEGORY_NAME?.trim() ||
      "blog_category_name",
    blogSubCategories:
      process.env.BLOG_CATEGORY_FIELD_BLOG_SUB_CATEGORIES ?? "blog_sub_category",
    seoSocialGroup: process.env.BLOG_CATEGORY_FIELD_SEO_SOCIAL_GROUP ?? "seo",
    seoTitle:
      process.env.BLOG_CATEGORY_FIELD_SEO_TITLE?.trim() ||
      process.env.BLOG_CATEGORY_FIELD_SEO_TITLE_TAG?.trim() ||
      "title",
    seoPageUrl: process.env.BLOG_CATEGORY_FIELD_SEO_PAGE_URL ?? "page_url",
    seoPageUrlShape: loadSeoPageUrlShape(),
    ...loadSharedSeoPageUrlFields(),
    ...loadSharedSeoInnerFieldUids(),
    seoCanonical: process.env.BLOG_CATEGORY_FIELD_SEO_CANONICAL?.trim() ?? "",
    metaDescription: process.env.BLOG_CATEGORY_FIELD_META_DESCRIPTION ?? "meta_description",
    metaImageGroup: process.env.BLOG_CATEGORY_FIELD_META_IMAGE ?? "meta_image",
    metaImageFileField: process.env.BLOG_CATEGORY_SEO_META_IMAGE_FILE_FIELD?.trim() || "file",
    metaDescriptionSource: loadBlogCategoryMetaDescriptionSource(),
    fileRefShape: loadBlogAuthorFileRefShape(),
  };
}
