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
  };
};

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
