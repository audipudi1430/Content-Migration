import { blogCategoryPageUrlPath, loadBlogCategoryUrlLanguage } from "./blog-category-config.js";
import type { WpAuthorSeoSource } from "./blog-author-seo.js";
import { extractWpAuthorSeo, type WpAuthorSeoData } from "./blog-author-seo.js";

export type WpStoryCategory = WpAuthorSeoSource & {
  parent?: number;
  description?: string;
  yoast_head_json?: WpAuthorSeoSource["yoast_head_json"] & {
    og_image?: { url?: string }[];
  };
};

/** First OG image URL from Yoast. */
export function pickYoastOgImageUrl(term: WpStoryCategory): string {
  const images = term.yoast_head_json?.og_image;
  if (!Array.isArray(images) || images.length === 0) return "";
  return String(images[0]?.url ?? "").trim();
}

/** SEO data with category URL path `/{language}/category/{slug}`. */
export function extractWpCategorySeo(term: WpStoryCategory, slug: string): WpAuthorSeoData {
  const language = loadBlogCategoryUrlLanguage();
  const pageUrlPath = blogCategoryPageUrlPath(slug, language);
  const base = extractWpAuthorSeo(
    { ...term, link: term.link || pageUrlPath },
    pageUrlPath
  );
  return {
    ...base,
    pageUrlPath,
    canonicalPath: base.canonicalPath || pageUrlPath,
  };
}
