import type { VideoFieldUids } from "./video-entry-config.js";

export type VideoEmbedKind = "youtube" | "brightcove" | "brightcove_audio";

export type ParsedVideoEmbed = {
  kind: VideoEmbedKind;
  /** Normalized embed/watch URL stored on the video entry. */
  embedUrl: string;
  videoId: string;
  /** Stable CMS `title` / map key segment. */
  entryTitle: string;
  /** `MappingStore` key when `wpId` is 0. */
  mapSourceKey: string;
};

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function sanitizeTitlePart(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

/** Extract YouTube video id from common URL shapes. */
export function parseYoutubeVideoId(raw: string): string | undefined {
  const url = raw.trim();
  if (!url) return undefined;

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();

    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\/+/, "").split("/")[0];
      return id || undefined;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname.startsWith("/embed/")) {
        return u.pathname.split("/")[2] || undefined;
      }
      if (u.pathname.startsWith("/shorts/")) {
        return u.pathname.split("/")[2] || undefined;
      }
      const v = u.searchParams.get("v");
      if (v) return v;
    }
  } catch {
    const m = url.match(
      /(?:youtu\.be\/|youtube\.com\/(?:embed\/|watch\?v=|shorts\/))([A-Za-z0-9_-]{6,})/
    );
    return m?.[1];
  }

  return undefined;
}

export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}`;
}

function parseBrightcoveVideoId(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    const fromQuery = u.searchParams.get("videoId") ?? u.searchParams.get("video_id");
    if (fromQuery) return fromQuery;
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "videos");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    /* fall through */
  }
  const m = raw.match(/videoId=([A-Za-z0-9_-]+)/i);
  return m?.[1];
}

function isBrightcoveAudio(providerSlug: string, rawUrl: string): boolean {
  const p = providerSlug.toLowerCase();
  if (p.includes("audio")) return true;
  const u = rawUrl.toLowerCase();
  return u.includes("audio") && u.includes("brightcove");
}

/**
 * Parse a WordPress `core/embed` URL (+ optional `providerNameSlug`) into a video entry shape.
 */
export function parseVideoEmbed(embedUrl: string, providerSlug?: string): ParsedVideoEmbed | undefined {
  const raw = embedUrl.trim();
  if (!raw) return undefined;

  const provider = pickString(providerSlug).toLowerCase();

  if (provider === "youtube" || provider.includes("youtube") || parseYoutubeVideoId(raw)) {
    const videoId = parseYoutubeVideoId(raw);
    if (!videoId) return undefined;
    const embed = youtubeEmbedUrl(videoId);
    const titlePart = sanitizeTitlePart(videoId) || videoId;
    return {
      kind: "youtube",
      embedUrl: embed,
      videoId,
      entryTitle: `youtube_${titlePart}`,
      mapSourceKey: `embed:youtube:${videoId}`,
    };
  }

  const brightcoveHosts = ["brightcove", "bcove.video", "players.brightcove.net"];
  const hostMatch = (() => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return brightcoveHosts.some((h) => host.includes(h));
    } catch {
      return brightcoveHosts.some((h) => raw.toLowerCase().includes(h));
    }
  })();

  if (provider.includes("brightcove") || hostMatch) {
    const videoId = parseBrightcoveVideoId(raw);
    if (!videoId) return undefined;
    const audio = isBrightcoveAudio(provider, raw);
    const kind = audio ? "brightcove_audio" : "brightcove";
    const titlePart = sanitizeTitlePart(videoId) || videoId;
    return {
      kind,
      embedUrl: raw,
      videoId,
      entryTitle: `${audio ? "brightcove_audio" : "brightcove"}_${titlePart}`,
      mapSourceKey: `embed:${kind}:${videoId}`,
    };
  }

  return undefined;
}

export function buildVideoEntryPayload(
  parsed: ParsedVideoEmbed,
  fields: VideoFieldUids,
  opts?: { mediaTitle?: string; altText?: string }
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    title: parsed.entryTitle,
    [fields.url]: parsed.embedUrl,
  };

  if (opts?.mediaTitle) entry[fields.mediaTitle] = opts.mediaTitle;
  if (opts?.altText) entry[fields.altText] = opts.altText;

  switch (parsed.kind) {
    case "youtube":
      entry[fields.type] = fields.typeYoutube;
      entry[fields.youtubeUrl] = parsed.embedUrl;
      break;
    case "brightcove_audio":
      entry[fields.type] = fields.typeBrightcoveAudio;
      entry[fields.brightcoveMediaId] = parsed.videoId;
      break;
    case "brightcove":
      entry[fields.type] = fields.typeBrightcove;
      entry[fields.brightcoveMediaId] = parsed.videoId;
      break;
  }

  return entry;
}
