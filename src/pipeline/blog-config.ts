/**
 * Blog (`blog`) content type field UIDs and URL pattern.
 *
 * Public URL: `/articles/{slug}` — see `blogArticlePageUrlPath`.
 */

import type { FileRefShape } from "./blog-author-config.js";
import { loadBlogAuthorFileRefShape } from "./blog-author-config.js";
import type { MetaDescriptionSource } from "./blog-author-seo.js";
import type { WpEntityKind } from "../mapping-store.js";
import type { SeoSocialFieldUids } from "./seo-social-payload.js";

export type BlogReferenceShape = "object" | "array";

/** How banner_image is modeled on the content type (same options as category_thumbnail). */
export type BannerImageLayout = "group" | "global" | "file";

export type BlogFieldUids = SeoSocialFieldUids & {
  /** CMS Asset Name (entry title + field UID). */
  cmsAssetName: string;
  url: string;
  blogCategory: string;
  showInNewsroomLanding: string;
  showInLatestBlogs: string;
  seriesLabel: string;
  blogTopics: string;
  headline: string;
  subHeader: string;
  shortLinkText: string;
  /** Date and Time (`isodate`) displayed on the blog. */
  dateline: string;
  bannerImage: string;
  /** Nested file field UID inside banner image group/global (`file` in your stack). */
  bannerImageFileField: string;
  bannerImageLayout: BannerImageLayout;
  /** Thumbnail global field UID (`reference_to: image_preset`). */
  thumbnail: string;
  /** Nested `image_preset` global inside thumbnail (default `image`). */
  thumbnailImagePresetField: string;
  /** Image Preset Picker custom field inside `image_preset` (default `image`). */
  thumbnailPresetImageField: string;
  /** Image Preset Builder extension UID (set when stack requires full preset metadata). */
  thumbnailPresetExtensionUid: string;
  /** Optional default image preset UID for the picker. */
  thumbnailPresetUid: string;
  /** Optional preset display name (e.g. `Test_Preset`). */
  thumbnailPresetName: string;
  bannerVideo: string;
  byline: string;
  blogAuthorProfile: string;
  referenceShape: BlogReferenceShape;
  /** `name` = headline/title; `wp_seo` = Yoast/meta description when present. */
  metaDescriptionSource: MetaDescriptionSource;
  fileRefShape: FileRefShape;
};

export function loadBlogMetaDescriptionSource(): MetaDescriptionSource {
  return (process.env.BLOG_META_DESCRIPTION_SOURCE ?? "wp_seo").toLowerCase() === "name"
    ? "name"
    : "wp_seo";
}

function loadBannerImageLayout(): BannerImageLayout {
  const layout = (process.env.BLOG_BANNER_IMAGE_LAYOUT ?? "").toLowerCase();
  if (layout === "group" || layout === "global" || layout === "file") return layout;
  if (process.env.BLOG_BANNER_IMAGE_IS_GLOBAL === "1") return "global";
  if (process.env.BLOG_BANNER_IMAGE_IS_GLOBAL === "0") return "group";
  return "group";
}

function loadBlogSeoPageUrlShape(): "string" | "modular" | "group" {
  const raw = (process.env.BLOG_SEO_PAGE_URL_SHAPE ?? "group").toLowerCase();
  if (raw === "modular") return "modular";
  if (raw === "string") return "string";
  return "group";
}

export function loadBlogReferenceShape(): BlogReferenceShape {
  const raw = (process.env.BLOG_REFERENCE_SHAPE ?? "object").toLowerCase();
  return raw === "array" ? "array" : "object";
}

export function loadBlogContentTypeUid(): string {
  return (
    process.env.MIGRATION_CONTENT_TYPE_UID?.trim() ||
    process.env.CS_CONTENT_TYPE_BLOG?.trim() ||
    "blog"
  );
}

/** Content type UID for `blog_category` references. */
export function loadBlogCategoryRefContentTypeUid(): string {
  return process.env.BLOG_REF_CONTENT_TYPE_CATEGORY?.trim() || "blog_category";
}

/** Content type UID for `blog_author_profile` references. */
export function loadBlogAuthorRefContentTypeUid(): string {
  return process.env.BLOG_REF_CONTENT_TYPE_AUTHOR?.trim() || "blog_author";
}

/** Content type UID for `series_label` references (optional). */
export function loadBlogSeriesRefContentTypeUid(): string {
  return process.env.BLOG_REF_CONTENT_TYPE_SERIES?.trim() || "";
}

/** WordPress taxonomy REST key for categories on story posts (default `story_category`). */
export function loadBlogWpTaxonomyCategory(): string {
  return process.env.BLOG_WP_TAXONOMY_CATEGORY?.trim() || "story_category";
}

/** WordPress taxonomy REST key for authors on story posts (default `story_author`). */
export function loadBlogWpTaxonomyAuthor(): string {
  return process.env.BLOG_WP_TAXONOMY_AUTHOR?.trim() || "story_author";
}

/**
 * Public path: `/articles/{slug}`.
 * Template override: `BLOG_URL_TEMPLATE` with `{slug}`.
 */
export function blogArticlePageUrlPath(slug: string): string {
  const s = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  const template = process.env.BLOG_URL_TEMPLATE?.trim() || "/articles/{slug}";
  return template
    .replace(/\{slug\}/g, s || "")
    .replace(/\/+/g, "/")
    .replace(/^(?!\/)/, "/");
}

export function loadBlogFieldUids(): BlogFieldUids {
  const bannerFile = process.env.BLOG_BANNER_IMAGE_FILE_FIELD?.trim() || "file";

  return {
    cmsAssetName: process.env.BLOG_FIELD_CMS_ASSET_NAME ?? "title",
    url: process.env.BLOG_FIELD_URL ?? "url",
    blogCategory: process.env.BLOG_FIELD_BLOG_CATEGORY ?? "blog_category",
    showInNewsroomLanding:
      process.env.BLOG_FIELD_SHOW_IN_NEWSROOM_LANDING ?? "show_in_newsroom_landing",
    showInLatestBlogs: process.env.BLOG_FIELD_SHOW_IN_LATEST_BLOGS ?? "show_in_latest_blogs",
    seriesLabel: process.env.BLOG_FIELD_SERIES_LABEL ?? "series_label",
    blogTopics: process.env.BLOG_FIELD_BLOG_TOPICS ?? "blog_topics",
    headline: process.env.BLOG_FIELD_HEADLINE ?? "headline",
    subHeader: process.env.BLOG_FIELD_SUB_HEADER ?? "sub_header",
    shortLinkText: process.env.BLOG_FIELD_SHORT_LINK_TEXT ?? "short_link_text",
    dateline: process.env.BLOG_FIELD_DATELINE ?? "dateline",
    bannerImage: process.env.BLOG_FIELD_BANNER_IMAGE ?? "banner_image",
    bannerImageFileField: bannerFile,
    bannerImageLayout: loadBannerImageLayout(),
    thumbnail: process.env.BLOG_FIELD_THUMBNAIL ?? "thumbnail",
    thumbnailImagePresetField:
      process.env.BLOG_THUMBNAIL_IMAGE_PRESET_FIELD?.trim() || "image",
    thumbnailPresetImageField:
      process.env.BLOG_THUMBNAIL_PRESET_IMAGE_FIELD?.trim() || "image",
    thumbnailPresetExtensionUid: process.env.BLOG_THUMBNAIL_PRESET_EXTENSION_UID?.trim() || "",
    thumbnailPresetUid: process.env.BLOG_THUMBNAIL_PRESET_UID?.trim() || "",
    thumbnailPresetName: process.env.BLOG_THUMBNAIL_PRESET_NAME?.trim() || "",
    bannerVideo: process.env.BLOG_FIELD_BANNER_VIDEO ?? "banner_video",
    byline: process.env.BLOG_FIELD_BYLINE ?? "byline",
    blogAuthorProfile: process.env.BLOG_FIELD_BLOG_AUTHOR_PROFILE ?? "blog_author_profile",
    referenceShape: loadBlogReferenceShape(),
    seoSocialGroup: process.env.BLOG_FIELD_SEO_SOCIAL_GROUP ?? "seo",
    seoTitle:
      process.env.BLOG_FIELD_SEO_TITLE?.trim() ||
      process.env.BLOG_FIELD_SEO_TITLE_TAG?.trim() ||
      "title",
    seoPageUrl: process.env.BLOG_FIELD_SEO_PAGE_URL ?? "page_url",
    seoPageUrlShape: loadBlogSeoPageUrlShape(),
    seoPageUrlInnerUrl: process.env.BLOG_FIELD_SEO_PAGE_URL_URL ?? "url",
    seoPageUrlInnerStatus: process.env.BLOG_FIELD_SEO_PAGE_URL_STATUS ?? "status",
    seoPageUrlStatusDefault: process.env.BLOG_SEO_PAGE_URL_STATUS_DEFAULT ?? "200",
    seoCanonical: process.env.BLOG_FIELD_SEO_CANONICAL?.trim() ?? "",
    metaDescription: process.env.BLOG_FIELD_META_DESCRIPTION ?? "meta_description",
    metaImageGroup: process.env.BLOG_FIELD_META_IMAGE ?? "meta_image",
    metaImageFileField: process.env.BLOG_SEO_META_IMAGE_FILE_FIELD?.trim() || "file",
    metaDescriptionSource: loadBlogMetaDescriptionSource(),
    fileRefShape: loadBlogAuthorFileRefShape(),
  };
}

/** Optional select defaults when WordPress has no source (omit from payload when unset). */
export function loadBlogSelectDefaults(): {
  showInNewsroomLanding?: string;
  showInLatestBlogs?: string;
} {
  const news = process.env.BLOG_DEFAULT_SHOW_IN_NEWSROOM_LANDING?.trim();
  const latest = process.env.BLOG_DEFAULT_SHOW_IN_LATEST_BLOGS?.trim();
  return {
    showInNewsroomLanding: news || undefined,
    showInLatestBlogs: latest || undefined,
  };
}

/** WordPress `meta` keys for optional scalar fields (omit when empty). */
export function loadBlogMetaKeys(): {
  subHeader: string;
  shortLinkText: string;
  byline: string;
  blogTopics: string;
  seriesLabel: string;
} {
  return {
    subHeader: process.env.BLOG_META_SUB_HEADER?.trim() || "subhead",
    shortLinkText: process.env.BLOG_META_SHORT_LINK_TEXT?.trim() || "",
    byline: process.env.BLOG_META_BYLINE?.trim() || "",
    blogTopics: process.env.BLOG_META_BLOG_TOPICS?.trim() || "",
    seriesLabel: process.env.BLOG_META_SERIES_LABEL?.trim() || "",
  };
}

/** Where WordPress `featured_media` is mapped: `thumbnail` (default) or legacy `banner_image`. */
export function loadBlogFeaturedImageTarget(): "thumbnail" | "banner_image" {
  const raw = (process.env.BLOG_FEATURED_IMAGE_TARGET ?? "thumbnail").toLowerCase();
  return raw === "banner_image" || raw === "banner" ? "banner_image" : "thumbnail";
}

/** WordPress mapping kind for series_label references (default `custom`). */
export function loadBlogSeriesMappingKind(): WpEntityKind {
  const raw = (process.env.BLOG_SERIES_MAPPING_KIND ?? "custom").toLowerCase();
  if (
    raw === "category" ||
    raw === "tag" ||
    raw === "post" ||
    raw === "page" ||
    raw === "story_author" ||
    raw === "custom"
  ) {
    return raw;
  }
  return "custom";
}
