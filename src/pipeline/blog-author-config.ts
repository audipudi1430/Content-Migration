/**
 * Contentstack **field UID** strings (API keys on the content type), not the shape of stored values.
 *
 * Mapping flow (blog authors):
 * 1. `migrate-blog-authors.ts` — loads WP `story_author`, builds `entryPayload`, POST/PUT via CMA.
 * 2. `blog-author-config.ts` — field UIDs from env (`BLOG_AUTHOR_FIELD_*`).
 * 3. `blog-author-payload.ts` — value shapes: description (html/text/json_rte), file refs `[{ uid }]`, global author_image.
 * 4. `contentstack-rte.ts` — WP description → HTML / plain / JSON RTE.
 * 5. `resolve-wp-image-asset.ts` — WP attachment id → Contentstack asset UID for author_image / meta_image.
 */
export type BlogAuthorFieldUids = {
  cmsAssetName: string;
  url: string;
  authorTitle: string;
  authorName: string;
  description: string;
  /**
   * Top-level field UID for author image (often a Global field on the content type).
   * When `authorImageIsGlobal` is true, asset is set on the nested key below.
   */
  authorImage: string;
  /** Nested field UID inside the Global field module that holds the file reference. */
  authorImageGlobalInnerField: string;
  /** If true, `authorImage` is sent as `{ [innerField]: [{ uid }] }` not a top-level file array. */
  authorImageIsGlobal: boolean;
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
    authorImageGlobalInnerField:
      process.env.BLOG_AUTHOR_GLOBAL_AUTHOR_IMAGE_INNER_FIELD?.trim() || "image",
    authorImageIsGlobal: process.env.BLOG_AUTHOR_AUTHOR_IMAGE_IS_GLOBAL !== "0",
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
