import { blogCategoryPageUrlPath, loadBlogCategoryUrlLanguage } from "./blog-category-config.js";
import type { WpAuthorSeoSource } from "./blog-author-seo.js";
import { extractWpAuthorSeo, type WpAuthorSeoData } from "./blog-author-seo.js";

export type WpStoryCategory = WpAuthorSeoSource & {
  parent?: number;
  description?: string;
};

export { pickYoastOgImageUrl } from "./blog-author-seo.js";

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
