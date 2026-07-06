import { WordPressClient } from "./client.js";

/** WordPress REST media object (`/wp/v2/media`). */
export type WpMediaRestItem = {
  id: number;
  slug?: string;
  source_url?: string;
  mime_type?: string;
  media_type?: string;
  alt_text?: string;
  author?: number;
  post?: number;
  title?: { rendered?: string };
  caption?: { rendered?: string };
  description?: { rendered?: string };
  media_details?: {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
  };
};

export type WordPressMediaMetadata = {
  wordpress_id: number;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  source_url: string;
  upload_path: string;
  mime_type: string;
  media_type: string;
  width: number | undefined;
  height: number | undefined;
  filesize: number | undefined;
  author: number | undefined;
  attached_to_post: number | undefined;
  slug: string;
  match_method?: string;
};

export class WordPressMediaNotFoundError extends Error {
  constructor(
    public readonly imageUrl: string,
    message?: string
  ) {
    super(message ?? `No WordPress media attachment matched URL: ${imageUrl}`);
    this.name = "WordPressMediaNotFoundError";
  }
}

const MEDIA_COLLECTION = "/wp-json/wp/v2/media";

export type MediaMatchMethod =
  | "slug"
  | "upload_path"
  | "source_url"
  | "filename"
  | "source_url_loose"
  | "wp_id_in_url";

export type FindMediaResult = {
  media: WpMediaRestItem;
  matchMethod: MediaMatchMethod;
};

/**
 * Path under `wp-content/uploads/`, e.g. `2026/04/GettyImages-926537574-1.jpg`.
 */
export function getUploadRelativePath(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const m = u.pathname.match(/\/wp-content\/uploads\/(.+)$/i);
    if (!m?.[1]) return null;
    return decodeURIComponent(m[1].replace(/\/+$/, ""));
  } catch {
    const m = t.match(/wp-content\/uploads\/(.+?)(?:\?|#|$)/i);
    if (!m?.[1]) return null;
    return decodeURIComponent(m[1].replace(/\/+$/, ""));
  }
}

export function normalizeUrl(url: string): string {
  const t = url.trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    u.hash = "";
    u.search = "";
    u.protocol = "https:";
    const path = decodeURIComponent(u.pathname.replace(/\/+$/, "")).toLowerCase();
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return t.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "").toLowerCase();
  }
}

export function getFilenameWithoutExtension(urlOrPath: string): string {
  const segment = urlOrPath.trim().split(/[/\\]/).pop() ?? urlOrPath;
  const base = segment.replace(/\.[a-z0-9]{2,5}$/i, "");
  return base.replace(/-(\d+)x(\d+)$/i, "");
}

function stripImageSizeSuffix(filename: string): string {
  return filename.replace(/-(\d+)x(\d+)(\.[a-z0-9]+)?$/i, "$3");
}

function normalizeUploadPath(p: string): string {
  return decodeURIComponent(p.replace(/^\/+/, "").replace(/\\/g, "/")).toLowerCase();
}

function uploadRelativePathCandidates(imageUrl: string): string[] {
  const rel = getUploadRelativePath(imageUrl);
  if (!rel) return [];
  const out = new Set<string>();
  out.add(normalizeUploadPath(rel));
  const parts = rel.split("/");
  const file = parts.pop();
  if (file) {
    const stripped = stripImageSizeSuffix(file);
    if (stripped !== file) {
      out.add(normalizeUploadPath([...parts, stripped].filter(Boolean).join("/")));
    }
  }
  return [...out];
}

/**
 * Slug candidates derived from the image URL (filename, stem, size-stripped).
 * Used for the fast `?slug=` lookup before deeper matching.
 */
export function mediaSlugCandidatesFromUrl(imageUrl: string): string[] {
  const raw: string[] = [];
  const rel = getUploadRelativePath(imageUrl);
  if (rel) {
    const file = rel.split("/").pop()!;
    raw.push(file, stripImageSizeSuffix(file));
    const noExt = file.replace(/\.[a-z0-9]{2,5}$/i, "");
    if (noExt && noExt !== file) {
      raw.push(noExt, stripImageSizeSuffix(noExt));
    }
  }
  try {
    const parts = new URL(imageUrl.trim()).pathname
      .split("/")
      .map((s) => decodeURIComponent(s))
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && !/^\d{1,12}$/.test(last)) {
      raw.push(last, stripImageSizeSuffix(last));
      const noExt = last.replace(/\.[a-z0-9]{2,5}$/i, "");
      if (noExt) raw.push(noExt, stripImageSizeSuffix(noExt));
    }
  } catch {
    // ignore
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (t.length <= 1 || t.length >= 200) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const s of raw) {
    add(s);
    add(s.toLowerCase());
  }
  return out;
}

function pickRendered(field: unknown): string {
  if (typeof field === "string") return field.trim();
  if (field && typeof field === "object" && "rendered" in field) {
    return String((field as { rendered?: string }).rendered ?? "").trim();
  }
  return "";
}

export function extractMediaMetadata(
  media: WpMediaRestItem,
  matchMethod?: MediaMatchMethod
): WordPressMediaMetadata {
  const details = media.media_details;
  return {
    wordpress_id: media.id,
    title: pickRendered(media.title),
    alt_text: typeof media.alt_text === "string" ? media.alt_text : "",
    caption: pickRendered(media.caption),
    description: pickRendered(media.description),
    source_url: media.source_url ?? "",
    upload_path: details?.file ?? "",
    mime_type: media.mime_type ?? "",
    media_type: media.media_type ?? "",
    width: details?.width,
    height: details?.height,
    filesize: details?.filesize,
    author: media.author,
    attached_to_post: media.post,
    slug: media.slug ?? "",
    match_method: matchMethod,
  };
}

type StrictTier = "upload_path" | "source_url" | "filename" | "slug";

function strictMatchTier(
  media: WpMediaRestItem,
  normalizedOriginal: string,
  uploadCandidates: string[],
  filenameStem: string
): StrictTier | null {
  const file = media.media_details?.file;
  if (file && uploadCandidates.length > 0) {
    if (uploadCandidates.includes(normalizeUploadPath(file))) return "upload_path";
  }
  if (media.source_url && normalizedOriginal) {
    if (normalizeUrl(media.source_url) === normalizedOriginal) return "source_url";
  }
  if (filenameStem.length >= 2) {
    const fromFile = file ? getFilenameWithoutExtension(file) : "";
    const fromSource = media.source_url ? getFilenameWithoutExtension(media.source_url) : "";
    const stem = filenameStem.toLowerCase();
    if (fromFile.toLowerCase() === stem || fromSource.toLowerCase() === stem) return "filename";
  }
  if (filenameStem.length >= 2 && media.slug?.toLowerCase() === filenameStem.toLowerCase()) {
    return "slug";
  }
  return null;
}

function looseSourceUrlMatches(media: WpMediaRestItem, normalizedOriginal: string): boolean {
  if (!media.source_url || !normalizedOriginal) return false;
  const n = normalizeUrl(media.source_url);
  return n === normalizedOriginal || normalizedOriginal.endsWith(n) || n.endsWith(normalizedOriginal);
}

async function fetchMediaBySlug(
  wp: WordPressClient,
  slug: string
): Promise<WpMediaRestItem[]> {
  try {
    const items = await wp.getJson<WpMediaRestItem[]>(MEDIA_COLLECTION, {
      slug: slug.slice(0, 200),
      per_page: "10",
    });
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * Phase 1: `?slug=` for each candidate from the URL filename.
 * Accept when slug matches and the attachment corroborates the URL (or slug is an exact REST hit).
 */
async function findMediaBySlugFirst(
  wp: WordPressClient,
  imageUrl: string,
  slugCandidates: string[],
  normalizedOriginal: string,
  uploadCandidates: string[],
  filenameStem: string
): Promise<FindMediaResult | null> {
  for (const slug of slugCandidates) {
    const items = await fetchMediaBySlug(wp, slug);
    if (items.length === 0) continue;

    const exactSlug = items.find((x) => String(x.slug ?? "").toLowerCase() === slug.toLowerCase());
    const pick = exactSlug ?? items[0]!;
    if (typeof pick.id !== "number" || pick.id <= 0) continue;

    const tier = strictMatchTier(pick, normalizedOriginal, uploadCandidates, filenameStem);
    if (tier) {
      return { media: pick, matchMethod: tier === "slug" ? "slug" : tier };
    }

    // Slug REST hit with exact slug — use first (slug-first), URL may differ from disk path.
    if (exactSlug) {
      return { media: exactSlug, matchMethod: "slug" };
    }

    if (looseSourceUrlMatches(pick, normalizedOriginal)) {
      return { media: pick, matchMethod: "source_url_loose" };
    }
  }
  return null;
}

async function searchMedia(wp: WordPressClient, searchTerm: string): Promise<WpMediaRestItem[]> {
  try {
    const items = await wp.getJson<WpMediaRestItem[]>(MEDIA_COLLECTION, {
      search: searchTerm.slice(0, 80),
      per_page: "100",
    });
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * Phase 2: `?search=` then filter — upload path, source_url, filename (never blind first result).
 */
function findInSearchResults(
  items: WpMediaRestItem[],
  normalizedOriginal: string,
  uploadCandidates: string[],
  filenameStem: string
): FindMediaResult | null {
  const tierRank: Record<StrictTier, number> = {
    upload_path: 4,
    source_url: 3,
    filename: 2,
    slug: 1,
  };
  let best: { item: WpMediaRestItem; tier: StrictTier } | null = null;

  for (const item of items) {
    if (typeof item.id !== "number" || item.id <= 0) continue;
    const tier = strictMatchTier(item, normalizedOriginal, uploadCandidates, filenameStem);
    if (!tier) continue;
    if (!best || tierRank[tier] > tierRank[best.tier]) {
      best = { item, tier };
      if (tier === "upload_path") break;
    }
  }
  if (best) {
    const method: MediaMatchMethod =
      best.tier === "upload_path"
        ? "upload_path"
        : best.tier === "source_url"
          ? "source_url"
          : best.tier === "filename"
            ? "filename"
            : "slug";
    return { media: best.item, matchMethod: method };
  }

  for (const item of items) {
    if (typeof item.id !== "number" || item.id <= 0) continue;
    if (looseSourceUrlMatches(item, normalizedOriginal)) {
      return { media: item, matchMethod: "source_url_loose" };
    }
  }
  return null;
}

export async function findWordPressMediaByUrl(
  imageUrl: string,
  wordpressBaseUrl: string,
  authHeader?: string
): Promise<WpMediaRestItem> {
  const wp = new WordPressClient(wordpressBaseUrl.replace(/\/$/, ""), authHeader);
  const found = await findWordPressMediaByUrlWithClient(imageUrl, wp);
  if (!found) {
    throw new WordPressMediaNotFoundError(imageUrl);
  }
  return found.media;
}

/**
 * Resolve media for an image URL:
 * 1. Slug candidates + URL corroboration (fast path).
 * 2. Search + upload path / source_url / filename filter.
 * 3. Loose source_url match in search results.
 */
export async function findWordPressMediaByUrlWithClient(
  imageUrl: string,
  wp: WordPressClient
): Promise<FindMediaResult | null> {
  const url = imageUrl.trim();
  if (!url) return null;

  const normalizedOriginal = normalizeUrl(url);
  const uploadCandidates = uploadRelativePathCandidates(url);
  const rel = getUploadRelativePath(url);
  const filenameStem = rel ? getFilenameWithoutExtension(rel) : getFilenameWithoutExtension(url);
  const slugCandidates = mediaSlugCandidatesFromUrl(url);

  const bySlug = await findMediaBySlugFirst(
    wp,
    url,
    slugCandidates,
    normalizedOriginal,
    uploadCandidates,
    filenameStem
  );
  if (bySlug) return bySlug;

  const searchTerm =
    filenameStem.slice(0, 80) || slugCandidates[0]?.slice(0, 80) || (rel?.split("/").pop() ?? "");
  if (searchTerm.length >= 2) {
    const items = await searchMedia(wp, searchTerm);
    const fromSearch = findInSearchResults(items, normalizedOriginal, uploadCandidates, filenameStem);
    if (fromSearch) return fromSearch;
  }

  return null;
}

/** Fetch full media object by attachment id (fallback when URL matching fails but id is known). */
export async function fetchWordPressMediaById(
  wp: WordPressClient,
  mediaId: number,
  restPath = MEDIA_COLLECTION
): Promise<WpMediaRestItem | null> {
  if (mediaId <= 0) return null;
  try {
    const base = restPath.replace(/^\//, "").replace(/\/$/, "");
    return await wp.getJson<WpMediaRestItem>(`${base}/${mediaId}`);
  } catch {
    return null;
  }
}
