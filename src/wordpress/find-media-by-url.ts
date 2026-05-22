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

/**
 * Path under `wp-content/uploads/`, e.g. `2026/04/GettyImages-926537574-1.jpg`.
 * Returns null when the URL is not an uploads file URL.
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

/**
 * Compare URLs without query/hash, trailing slashes, and with http/https treated the same.
 */
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

/** Basename without extension, for narrowing `?search=` only — not used as the primary match key. */
export function getFilenameWithoutExtension(urlOrPath: string): string {
  const segment = urlOrPath.trim().split(/[/\\]/).pop() ?? urlOrPath;
  const base = segment.replace(/\.[a-z0-9]{2,5}$/i, "");
  return base.replace(/-(\d+)x(\d+)$/i, "");
}

/** WordPress often stores slugs without size suffixes or extensions; filenames on disk differ from `slug`. */
function stripImageSizeSuffix(filename: string): string {
  return filename.replace(/-(\d+)x(\d+)(\.[a-z0-9]+)?$/i, "$3");
}

function normalizeUploadPath(p: string): string {
  return decodeURIComponent(p.replace(/^\/+/, "").replace(/\\/g, "/")).toLowerCase();
}

/** Candidate upload-relative paths (original + size-stripped filename). */
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

function pickRendered(field: unknown): string {
  if (typeof field === "string") return field.trim();
  if (field && typeof field === "object" && "rendered" in field) {
    return String((field as { rendered?: string }).rendered ?? "").trim();
  }
  return "";
}

/**
 * Structured fields for migration / tracking after a definitive media match.
 */
export function extractMediaMetadata(media: WpMediaRestItem): WordPressMediaMetadata {
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
  };
}

type MatchTier = "upload_path" | "source_url" | "filename" | "slug";

function matchTier(
  media: WpMediaRestItem,
  normalizedOriginal: string,
  uploadCandidates: string[],
  filenameStem: string
): MatchTier | null {
  const file = media.media_details?.file;
  if (file && uploadCandidates.length > 0) {
    const normFile = normalizeUploadPath(file);
    if (uploadCandidates.includes(normFile)) return "upload_path";
  }

  if (media.source_url && normalizedOriginal) {
    if (normalizeUrl(media.source_url) === normalizedOriginal) return "source_url";
  }

  // Filename-only fallback: basename of upload_path or source_url vs original file stem.
  if (filenameStem.length >= 2) {
    const fromFile = file ? getFilenameWithoutExtension(file) : "";
    const fromSource = media.source_url ? getFilenameWithoutExtension(media.source_url) : "";
    const stem = filenameStem.toLowerCase();
    if (fromFile.toLowerCase() === stem || fromSource.toLowerCase() === stem) return "filename";
  }

  // Slug is unreliable (often differs from disk path and public URL) — last resort only.
  if (filenameStem.length >= 2 && media.slug) {
    const slug = media.slug.toLowerCase();
    if (slug === filenameStem.toLowerCase()) return "slug";
  }

  return null;
}

const TIER_RANK: Record<MatchTier, number> = {
  upload_path: 4,
  source_url: 3,
  filename: 2,
  slug: 1,
};

function pickBestMatch(
  items: WpMediaRestItem[],
  normalizedOriginal: string,
  uploadCandidates: string[],
  filenameStem: string
): WpMediaRestItem | null {
  let best: { item: WpMediaRestItem; tier: MatchTier } | null = null;
  for (const item of items) {
    if (typeof item.id !== "number" || item.id <= 0) continue;
    const tier = matchTier(item, normalizedOriginal, uploadCandidates, filenameStem);
    if (!tier) continue;
    if (!best || TIER_RANK[tier] > TIER_RANK[best.tier]) {
      best = { item, tier };
      if (tier === "upload_path") break;
    }
  }
  return best?.item ?? null;
}

/**
 * Find the exact media attachment for a public image/file URL.
 *
 * 1. Narrow candidates with `?search={filename}` (does not assume first hit is correct).
 * 2. Filter results: `media_details.file` (upload-relative path) → `source_url` → filename → slug.
 *
 * @param imageUrl Public or uploads URL from Excel / site HTML
 * @param wordpressBaseUrl Site root, e.g. `https://news-editor.example.com`
 * @param authHeader Optional `Basic …` for authenticated REST
 * @returns Matched media object
 * @throws WordPressMediaNotFoundError when no exact match exists in the search set
 */
export async function findWordPressMediaByUrl(
  imageUrl: string,
  wordpressBaseUrl: string,
  authHeader?: string
): Promise<WpMediaRestItem> {
  const wp = new WordPressClient(wordpressBaseUrl.replace(/\/$/, ""), authHeader);
  const found = await findWordPressMediaByUrlWithClient(imageUrl, wp);
  if (!found) {
    throw new WordPressMediaNotFoundError(
      imageUrl,
      "No media item matched upload path or source_url after search (slug is not used as primary key)."
    );
  }
  return found;
}

/** Same as {@link findWordPressMediaByUrl} but reuses an existing {@link WordPressClient}. */
export async function findWordPressMediaByUrlWithClient(
  imageUrl: string,
  wp: WordPressClient
): Promise<WpMediaRestItem | null> {
  const url = imageUrl.trim();
  if (!url) return null;

  const normalizedOriginal = normalizeUrl(url);
  const uploadCandidates = uploadRelativePathCandidates(url);
  const rel = getUploadRelativePath(url);
  const filenameStem =
    rel ? getFilenameWithoutExtension(rel) : getFilenameWithoutExtension(url);

  if (filenameStem.length < 2 && !uploadCandidates.length && !normalizedOriginal) {
    return null;
  }

  const searchTerm = filenameStem.slice(0, 80) || (rel?.split("/").pop() ?? "").slice(0, 80);
  if (!searchTerm) return null;

  let items: WpMediaRestItem[] = [];
  try {
    items = await wp.getJson<WpMediaRestItem[]>(MEDIA_COLLECTION, {
      search: searchTerm,
      per_page: "100",
    });
  } catch {
    return null;
  }

  if (!Array.isArray(items) || items.length === 0) return null;

  const exact = pickBestMatch(items, normalizedOriginal, uploadCandidates, filenameStem);
  if (exact) return exact;

  // If search missed (common for hashed names), try slug= only when we have a single strong upload path candidate.
  if (uploadCandidates.length === 1 && filenameStem.length >= 2) {
    try {
      const bySlug = await wp.getJson<WpMediaRestItem[]>(MEDIA_COLLECTION, {
        slug: filenameStem.slice(0, 200),
        per_page: "10",
      });
      if (Array.isArray(bySlug) && bySlug.length > 0) {
        const fromSlug = pickBestMatch(bySlug, normalizedOriginal, uploadCandidates, filenameStem);
        if (fromSlug) return fromSlug;
      }
    } catch {
      // ignore
    }
  }

  return null;
}
