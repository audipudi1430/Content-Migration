/**
 * WordPress SEO data for story_author → Contentstack SEO & Social group.
 *
 * Sources (in priority order):
 * - Custom meta: `meta.seo_title`, `meta.meta_description`
 * - Yoast post meta: `meta._yoast_wpseo_title`, `meta._yoast_wpseo_metadesc`
 * - Yoast REST: `yoast_head_json.title`, `yoast_head_json.description`
 * - Public path: `link` pathname, else slug-based path from `blogAuthorPageUrlPath`
 */

export type WpAuthorSeoSource = {
  id: number;
  name: string;
  slug: string;
  link?: string;
  meta?: Record<string, unknown>;
  yoast_head_json?: {
    title?: string;
    description?: string;
    canonical?: string;
    og_url?: string;
    og_image?: { url?: string }[];
  };
};

export type MetaDescriptionSource = "name" | "wp_seo";

/** First OG image URL from Yoast (`yoast_head_json.og_image[0].url`). */
export function pickYoastOgImageUrl(term: WpAuthorSeoSource): string {
  const images = term.yoast_head_json?.og_image;
  if (!Array.isArray(images) || images.length === 0) return "";
  return pickString(images[0]?.url);
}

export type WpAuthorSeoData = {
  /** Browser / SEO title tag */
  seoTitleTag: string;
  /** Meta description from WP/Yoast (when not using title fallback) */
  metaDescription: string;
  /** Path only, e.g. /author/joe-baguley */
  pageUrlPath: string;
  canonicalPath: string;
};

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Pathname from full WordPress `link` URL. */
export function pathFromWpLink(link: string | undefined): string {
  const raw = pickString(link);
  if (!raw) return "";
  try {
    return new URL(raw).pathname || "";
  } catch {
    return raw.startsWith("/") ? raw.split("?")[0] ?? raw : "";
  }
}

export function extractWpAuthorSeo(term: WpAuthorSeoSource, fallbackUrlPath: string): WpAuthorSeoData {
  const m = term.meta ?? {};
  const yoast = term.yoast_head_json ?? {};

  const seoTitleTag =
    pickString(m.seo_title ?? m._yoast_wpseo_title) || pickString(yoast.title) || pickString(term.name);

  const metaDescription =
    pickString(m.meta_description ?? m._yoast_wpseo_metadesc) || pickString(yoast.description);

  const fromLink = pathFromWpLink(term.link);
  const fromYoastCanonical = pickString(yoast.canonical);
  const yoastCanonicalPath = fromYoastCanonical ? pathFromWpLink(fromYoastCanonical) || fromYoastCanonical : "";

  const pageUrlPath = fromLink || fallbackUrlPath;
  const canonicalPath = yoastCanonicalPath || fromLink || fallbackUrlPath;

  return { seoTitleTag, metaDescription, pageUrlPath, canonicalPath };
}

/**
 * Meta description for the SEO & Social group.
 * - `name` — entry/category name (default for blog_author and blog_category)
 * - `wp_seo` — Yoast / custom meta description when present
 */
export function resolveSeoMetaDescription(
  entryName: string,
  seo: WpAuthorSeoData,
  source: MetaDescriptionSource = "name"
): string {
  if (source === "wp_seo" && seo.metaDescription) return seo.metaDescription;
  return entryName;
}
