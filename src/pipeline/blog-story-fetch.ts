import type { WordPressClient } from "../wordpress/client.js";
import type { WpStory } from "./blog-seo.js";
import type { TrackingRow } from "./types.js";
import { collectSlugCandidates } from "./wp-extract-enrich.js";

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Slug used for `GET .../stories?slug=` (tracking row, URL, or fallback). */
export function storySlugForFetch(trackRef: Pick<TrackingRow, "wp_slug" | "url">): string {
  const fromRow = pickString(trackRef.wp_slug);
  if (fromRow) return fromRow;
  const candidates = collectSlugCandidates(trackRef.url, "content");
  return candidates[0] ?? "";
}

/**
 * Fetch a story via WordPress REST slug query (returns `content.blocks` + `content.rendered`).
 * `GET {site}/wp-json/wp/v2/stories?slug={slug}&per_page=10`
 */
export async function fetchWpStoryBySlug(
  wp: WordPressClient,
  restBase: string,
  slug: string,
  expectedWpId?: number
): Promise<WpStory & Record<string, unknown>> {
  const s = slug.replace(/^\/+|\/+$/g, "");
  if (!s) {
    throw new Error("fetchWpStoryBySlug: empty slug");
  }

  const base = restBase.replace(/^\//, "").replace(/\/$/, "");
  const items = await wp.getJson<Array<WpStory & Record<string, unknown>>>(base, {
    slug: s,
    per_page: "10",
  });

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`No story found for slug="${s}" (${base}?slug=${s})`);
  }

  const want = s.toLowerCase();
  const exact = items.find((x) => pickString(x.slug).toLowerCase() === want);
  const story = exact ?? items[0]!;

  if (expectedWpId && story.id !== expectedWpId) {
    console.error(
      `[blog] slug=${s} REST returned wp_id=${story.id} (tracking wp_id=${expectedWpId}); using slug response`
    );
  }

  return story;
}

/**
 * Load story for migration: slug query first (full `content.blocks`), ID fallback optional.
 */
export async function fetchWpStoryForMigration(
  wp: WordPressClient,
  restBase: string,
  trackRef: Pick<TrackingRow, "wp_slug" | "url">,
  wpId: number,
  fetchBySlug: boolean
): Promise<{ story: WpStory & Record<string, unknown>; fetchUrl: string }> {
  const base = restBase.replace(/^\//, "").replace(/\/$/, "");

  if (fetchBySlug) {
    const slug = storySlugForFetch(trackRef);
    if (!slug) {
      throw new Error(
        `No wp_slug for wp_id=${wpId}; re-run pipeline:extract or ensure URL/slug is on the tracking row`
      );
    }
    const story = await fetchWpStoryBySlug(wp, base, slug, wpId);
    return { story, fetchUrl: `${base}?slug=${encodeURIComponent(slug)}` };
  }

  const rel = `${base}/${wpId}`;
  const story = await wp.getJson<WpStory & Record<string, unknown>>(rel);
  return { story, fetchUrl: rel };
}

export function loadBlogFetchBySlug(): boolean {
  const raw = (process.env.BLOG_FETCH_BY_SLUG ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}
