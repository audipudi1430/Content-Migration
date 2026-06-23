import { blogArticlePageUrlPath } from "./blog-config.js";
import type { WpAuthorSeoSource } from "./blog-author-seo.js";
import { extractWpAuthorSeo, pickRenderedTitle as pickTitle, type WpAuthorSeoData } from "./blog-author-seo.js";
import { normalizeWpText } from "./contentstack-rte.js";

export type WpStory = WpAuthorSeoSource & {
  title?: { rendered?: string } | string;
  featured_media?: number;
};

export { pickYoastOgImageUrl } from "./blog-author-seo.js";

function storyDisplayName(story: WpStory): string {
  const fromTitle = pickTitle(story.title);
  if (fromTitle) return fromTitle;
  return normalizeWpText(String(story.name ?? ""));
}

/** SEO data with article URL path `/articles/{slug}`. */
export function extractWpStorySeo(story: WpStory, slug: string): WpAuthorSeoData {
  const pageUrlPath = blogArticlePageUrlPath(slug);
  const name = storyDisplayName(story) || `Story ${story.id}`;
  const base = extractWpAuthorSeo(
    { ...story, name, link: story.link || pageUrlPath },
    pageUrlPath
  );
  return {
    ...base,
    pageUrlPath,
    canonicalPath: base.canonicalPath || pageUrlPath,
  };
}
