/**
 * Contentstack `press_release` field UIDs and env defaults.
 * Separate from blog story config so story migration stays untouched.
 */
import { loadBlogAuthorFileRefShape, type FileRefShape } from "./blog-author-config.js";
import {
  loadSharedSeoInnerFieldUids,
  loadSharedSeoPageUrlFields,
  resolveSeoPageUrlShape,
  type SeoPageUrlShape,
} from "./seo-social-payload.js";

export type PressReleaseFieldUids = {
  /** Unique CMS Asset Name (`title`). */
  title: string;
  url: string;
  newsCategory: string;
  articleCategory: string;
  newsTitle: string;
  pageTitle: string;
  subtitle: string;
  description: string;
  body: string;
  contacts: string;
  location: string;
  releaseDate: string;
  publishDate: string;
  status: string;
  seoSocialGroup: string;
  seoTitle: string;
  seoPageUrl: string;
  seoPageUrlShape: SeoPageUrlShape;
  seoPageUrlInnerUrl: string;
  seoPageUrlInnerStatus: string;
  seoPageUrlStatusDefault: string;
  seoPageUrlCanonicalField: string;
  seoPageUrlListField: string;
  seoPageUrlListItemUrl: string;
  seoPageUrlListItemStatus: string;
  seoPageUrlListItemRedirect: string;
  seoCanonical: string;
  seoPageOwner: string;
  metaDescription: string;
  metaImageGroup: string;
  metaImageFileField: string;
  fileRefShape: FileRefShape;
  contentMetadata: string;
};

export function loadPressReleaseContentTypeUid(): string {
  return (
    process.env.CS_CONTENT_TYPE_PRESS_RELEASE?.trim() ||
    process.env.PRESS_RELEASE_CONTENT_TYPE?.trim() ||
    "press_release"
  );
}

export function loadPressReleaseArticleCategoryContentTypeUid(): string {
  return (
    process.env.PRESS_RELEASE_REF_CONTENT_TYPE_ARTICLE_CATEGORY?.trim() ||
    process.env.BLOG_REF_CONTENT_TYPE_CATEGORY?.trim() ||
    "blog_category"
  );
}

export function loadPressReleaseNewsCategoryContentTypeUid(): string {
  return process.env.PRESS_RELEASE_REF_CONTENT_TYPE_NEWS_CATEGORY?.trim() || "news_category";
}

/** Default location when sheet has none (field is mandatory on press_release). */
export function loadPressReleaseDefaultLocation(): string {
  return (
    process.env.PRESS_RELEASE_DEFAULT_LOCATION?.trim() || "SAN JOSE, Calif. United States"
  );
}

export function loadPressReleaseDefaultStatus(): string {
  return process.env.PRESS_RELEASE_DEFAULT_STATUS?.trim() || "Active";
}

/** URL template; `{slug}` replaced. Default matches Broadcom press release paths. */
export function loadPressReleaseUrlTemplate(): string {
  return (
    process.env.PRESS_RELEASE_URL_TEMPLATE?.trim() || "/company/news/releases/{slug}"
  );
}

export function pressReleasePageUrlPath(slug: string): string {
  const s = slug.replace(/^\/+|\/+$/g, "");
  return loadPressReleaseUrlTemplate().replace(/\{slug\}/gi, s);
}

export function loadPressReleaseFieldUids(): PressReleaseFieldUids {
  return {
    title: process.env.PRESS_RELEASE_FIELD_TITLE?.trim() || "title",
    url: process.env.PRESS_RELEASE_FIELD_URL?.trim() || "url",
    newsCategory: process.env.PRESS_RELEASE_FIELD_NEWS_CATEGORY?.trim() || "news_category",
    articleCategory:
      process.env.PRESS_RELEASE_FIELD_ARTICLE_CATEGORY?.trim() || "article_category",
    newsTitle: process.env.PRESS_RELEASE_FIELD_NEWS_TITLE?.trim() || "news_title",
    pageTitle: process.env.PRESS_RELEASE_FIELD_PAGE_TITLE?.trim() || "page_title",
    subtitle: process.env.PRESS_RELEASE_FIELD_SUBTITLE?.trim() || "subtitle",
    description: process.env.PRESS_RELEASE_FIELD_DESCRIPTION?.trim() || "description",
    body: process.env.PRESS_RELEASE_FIELD_BODY?.trim() || "body",
    contacts: process.env.PRESS_RELEASE_FIELD_CONTACTS?.trim() || "contacts",
    location: process.env.PRESS_RELEASE_FIELD_LOCATION?.trim() || "location",
    releaseDate: process.env.PRESS_RELEASE_FIELD_RELEASE_DATE?.trim() || "release_date",
    publishDate: process.env.PRESS_RELEASE_FIELD_PUBLISH_DATE?.trim() || "publish_date",
    status: process.env.PRESS_RELEASE_FIELD_STATUS?.trim() || "status",
    seoSocialGroup: process.env.PRESS_RELEASE_FIELD_SEO_SOCIAL_GROUP?.trim() || "seo",
    seoTitle: process.env.PRESS_RELEASE_FIELD_SEO_TITLE?.trim() || "title",
    seoPageUrl: process.env.PRESS_RELEASE_FIELD_SEO_PAGE_URL?.trim() || "page_url",
    seoPageUrlShape: resolveSeoPageUrlShape(
      process.env.PRESS_RELEASE_SEO_PAGE_URL_SHAPE,
      "canonical_url_list"
    ),
    ...loadSharedSeoPageUrlFields(),
    ...loadSharedSeoInnerFieldUids(),
    seoCanonical: process.env.PRESS_RELEASE_FIELD_SEO_CANONICAL?.trim() ?? "",
    metaDescription:
      process.env.PRESS_RELEASE_FIELD_META_DESCRIPTION?.trim() || "meta_description",
    metaImageGroup: process.env.PRESS_RELEASE_FIELD_META_IMAGE?.trim() || "meta_image",
    metaImageFileField:
      process.env.PRESS_RELEASE_SEO_META_IMAGE_FILE_FIELD?.trim() || "file",
    fileRefShape: loadBlogAuthorFileRefShape(),
    contentMetadata:
      process.env.PRESS_RELEASE_FIELD_CONTENT_METADATA?.trim() || "content_metadata",
  };
}
