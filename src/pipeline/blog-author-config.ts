/**
 * Contentstack **field UID** strings (API keys on the content type), not the shape of stored values.
 *
 * Mapping flow (blog authors):
 * 1. `migrate-blog-authors.ts` — loads WP `story_author`, builds `entryPayload`, POST/PUT via CMA.
 * 2. `blog-author-config.ts` — field UIDs from env (`BLOG_AUTHOR_FIELD_*`).
 * 3. `blog-author-payload.ts` — value shapes (description, author_image group, seo group).
 * 4. `blog-author-seo.ts` — read Yoast/custom meta from WordPress.
 * 5. `contentstack-rte.ts` — WP description → HTML / plain / JSON RTE.
 * 6. `resolve-wp-image-asset.ts` — WP attachment id → Contentstack asset UID.
 */

import type { SeoPageUrlShape } from "./seo-social-payload.js";
import { loadSharedSeoPageUrlFields, resolveSeoPageUrlShape } from "./seo-social-payload.js";

/** How the author image field is modeled on the content type. */
export type AuthorImageLayout = "group" | "global" | "file";

/**
 * CMA file field value shape (see Contentstack CMA “Create entry with assets”):
 * - `uid` — single file: `"blt..."` (default)
 * - `uid_array` — multiple: `["blt...", "blt..."]`
 * - `object` / `object_array` — `{ uid }` / `[{ uid }]` if your stack requires it
 */
export type FileRefShape = "uid" | "uid_array" | "object" | "object_array";

export type BlogAuthorFieldUids = {
  cmsAssetName: string;
  /** Legacy top-level URL field (optional); page URL for SEO lives under `seoSocial`. */
  url: string;
  authorTitle: string;
  authorName: string;
  description: string;
  authorImage: string;
  /** Nested file field UID inside Author Image group/global (`file` in your stack). */
  authorImageFileField: string;
  authorImageLayout: AuthorImageLayout;
  twitterLink: string;
  linkedinLink: string;
  facebookLink: string;
  /** SEO & Social group field UID on the content type. */
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
  /** Plain string inside SEO & Social group (required); mapped from WP `name`. */
  metaDescription: string;
  metaImageGroup: string;
  metaImageFileField: string;
  pageOwner: string;
  fileRefShape: FileRefShape;
};

function loadAuthorSeoPageUrlShape(): SeoPageUrlShape {
  return resolveSeoPageUrlShape(process.env.BLOG_AUTHOR_SEO_PAGE_URL_SHAPE, "modular");
}

export function loadBlogAuthorFileRefShape(): FileRefShape {
  const raw = (process.env.BLOG_AUTHOR_FILE_REF_SHAPE ?? "uid").toLowerCase();
  if (raw === "uid_array" || raw === "array" || raw === "multiple") return "uid_array";
  if (raw === "object_array") return "object_array";
  if (raw === "object" || raw === "single") return "object";
  return "uid";
}

function loadAuthorImageLayout(): AuthorImageLayout {
  const layout = (process.env.BLOG_AUTHOR_AUTHOR_IMAGE_LAYOUT ?? "").toLowerCase();
  if (layout === "group" || layout === "global" || layout === "file") return layout;
  if (process.env.BLOG_AUTHOR_AUTHOR_IMAGE_IS_GLOBAL === "1") return "global";
  if (process.env.BLOG_AUTHOR_AUTHOR_IMAGE_IS_GLOBAL === "0") return "group";
  return "group";
}

export function loadBlogAuthorFieldUids(): BlogAuthorFieldUids {
  const legacyGlobalInner = process.env.BLOG_AUTHOR_GLOBAL_AUTHOR_IMAGE_INNER_FIELD?.trim();
  const fileField =
    process.env.BLOG_AUTHOR_AUTHOR_IMAGE_FILE_FIELD?.trim() ||
    legacyGlobalInner ||
    "file";

  return {
    cmsAssetName: process.env.BLOG_AUTHOR_FIELD_CMS_ASSET_NAME ?? "cms_asset_name",
    url: process.env.BLOG_AUTHOR_FIELD_URL ?? "",
    authorTitle: process.env.BLOG_AUTHOR_FIELD_AUTHOR_TITLE ?? "author_title",
    authorName: process.env.BLOG_AUTHOR_FIELD_AUTHOR_NAME ?? "author_name",
    description: process.env.BLOG_AUTHOR_FIELD_DESCRIPTION ?? "description",
    authorImage: process.env.BLOG_AUTHOR_FIELD_AUTHOR_IMAGE ?? "author_image",
    authorImageFileField: fileField,
    authorImageLayout: loadAuthorImageLayout(),
    twitterLink: process.env.BLOG_AUTHOR_FIELD_TWITTER_LINK ?? "twitter_link",
    linkedinLink: process.env.BLOG_AUTHOR_FIELD_LINKEDIN_LINK ?? "linkedin_link",
    facebookLink: process.env.BLOG_AUTHOR_FIELD_FACEBOOK_LINK ?? "facebook_link",
    seoSocialGroup: process.env.BLOG_AUTHOR_FIELD_SEO_SOCIAL_GROUP ?? "seo",
    seoTitle:
      process.env.BLOG_AUTHOR_FIELD_SEO_TITLE?.trim() ||
      process.env.BLOG_AUTHOR_FIELD_SEO_TITLE_TAG?.trim() ||
      "title",
    seoPageUrl: process.env.BLOG_AUTHOR_FIELD_SEO_PAGE_URL ?? "page_url",
    seoPageUrlShape: loadAuthorSeoPageUrlShape(),
    ...loadSharedSeoPageUrlFields(),
    seoCanonical: process.env.BLOG_AUTHOR_FIELD_SEO_CANONICAL?.trim() ?? "canonical",
    metaDescription: process.env.BLOG_AUTHOR_FIELD_META_DESCRIPTION ?? "meta_description",
    metaImageGroup: process.env.BLOG_AUTHOR_FIELD_META_IMAGE ?? "meta_image",
    metaImageFileField: process.env.BLOG_AUTHOR_SEO_META_IMAGE_FILE_FIELD?.trim() || "file",
    pageOwner: process.env.BLOG_AUTHOR_FIELD_PAGE_OWNER ?? "page_owner",
    fileRefShape: loadBlogAuthorFileRefShape(),
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
 * Canonical public path for an author page when WordPress `link` is missing.
 * Override prefix with `BLOG_AUTHOR_PAGE_URL_PREFIX` (default `/news/author`).
 */
export function blogAuthorPageUrlPath(slug: string): string {
  const raw = (process.env.BLOG_AUTHOR_PAGE_URL_PREFIX ?? "/news/author").trim() || "/news/author";
  const base = raw.replace(/\/+$/, "");
  const lead = base.startsWith("/") ? base : `/${base}`;
  const s = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  return s ? `${lead}/${s}` : lead;
}
