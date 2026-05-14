/**
 * Contentstack **field UID** strings (API keys on the content type), not the shape of stored values.
 * Scalar fields get strings; file fields are still keyed by UID but the entry payload must be
 * `[{ uid: "<asset_uid>" }]` (see `setAssetRef` in migrate-blog-authors).
 */
export type BlogAuthorFieldUids = {
  cmsAssetName: string;
  url: string;
  authorTitle: string;
  authorName: string;
  description: string;
  /** Field UID for a single file/image reference in Contentstack. */
  authorImage: string;
  twitterLink: string;
  linkedinLink: string;
  facebookLink: string;
  seoTitleTag: string;
  /** Field UID for a single file/image reference (e.g. OG / meta image). */
  metaImage: string;
  metaDescription: string;
  pageOwner: string;
};

export function loadBlogAuthorFieldUids(): BlogAuthorFieldUids {
  return {
    cmsAssetName: process.env.BLOG_AUTHOR_FIELD_CMS_ASSET_NAME ?? "cms_asset_name",
    url: process.env.BLOG_AUTHOR_FIELD_URL ?? "url",
    authorTitle: process.env.BLOG_AUTHOR_FIELD_AUTHOR_TITLE ?? "author_title",
    authorName: process.env.BLOG_AUTHOR_FIELD_AUTHOR_NAME ?? "author_name",
    description: process.env.BLOG_AUTHOR_FIELD_DESCRIPTION ?? "description",
    authorImage: process.env.BLOG_AUTHOR_FIELD_AUTHOR_IMAGE ?? "author_image",
    twitterLink: process.env.BLOG_AUTHOR_FIELD_TWITTER_LINK ?? "twitter_link",
    linkedinLink: process.env.BLOG_AUTHOR_FIELD_LINKEDIN_LINK ?? "linkedin_link",
    facebookLink: process.env.BLOG_AUTHOR_FIELD_FACEBOOK_LINK ?? "facebook_link",
    seoTitleTag: process.env.BLOG_AUTHOR_FIELD_SEO_TITLE_TAG ?? "seo_title_tag",
    metaImage: process.env.BLOG_AUTHOR_FIELD_META_IMAGE ?? "meta_image",
    metaDescription: process.env.BLOG_AUTHOR_FIELD_META_DESCRIPTION ?? "meta_description",
    pageOwner: process.env.BLOG_AUTHOR_FIELD_PAGE_OWNER ?? "page_owner",
  };
}

export function loadBlogAuthorContentTypeUid(): string {
  return (
    process.env.MIGRATION_CONTENT_TYPE_UID?.trim() ||
    process.env.CS_CONTENT_TYPE_BLOG_AUTHOR?.trim() ||
    ""
  );
}

/**
 * Canonical public path for an author page in Contentstack, aligned with WordPress-style URLs
 * such as `/news/author/{slug}`. Override prefix with `BLOG_AUTHOR_PAGE_URL_PREFIX` (default `/news/author`).
 */
export function blogAuthorPageUrlPath(slug: string): string {
  const raw = (process.env.BLOG_AUTHOR_PAGE_URL_PREFIX ?? "/news/author").trim() || "/news/author";
  const base = raw.replace(/\/+$/, "");
  const lead = base.startsWith("/") ? base : `/${base}`;
  const s = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  return s ? `${lead}/${s}` : lead;
}
