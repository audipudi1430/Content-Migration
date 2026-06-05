/**
 * Blog (`blog`) content type field UIDs and URL pattern.
 *
 * Public URL: `/articles/{slug}` — see `blogArticlePageUrlPath`.
 */

import type { WpEntityKind } from "../mapping-store.js";

export type BlogReferenceShape = "object" | "array";

export type BlogFieldUids = {
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
  bannerVideo: string;
  byline: string;
  blogAuthorProfile: string;
  referenceShape: BlogReferenceShape;
};

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
    bannerVideo: process.env.BLOG_FIELD_BANNER_VIDEO ?? "banner_video",
    byline: process.env.BLOG_FIELD_BYLINE ?? "byline",
    blogAuthorProfile: process.env.BLOG_FIELD_BLOG_AUTHOR_PROFILE ?? "blog_author_profile",
    referenceShape: loadBlogReferenceShape(),
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
