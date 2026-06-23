import { extensionFromMimeType } from "../media/mime.js";
import type { WpMediaItem } from "../media/types.js";
import type { WordPressClient } from "../wordpress/client.js";
import { filenameForMedia, stripHtml } from "../media/utils.js";
import {
  exceedsImageSizeLimit,
  formatFileSizeBytes,
  loadMigrationImageMaxBytes,
} from "./image-size-limit.js";

/** When true (default), oversized images are resized/compressed instead of skipped. */
export function loadMigrationImageAutoReduce(): boolean {
  const raw = (process.env.MIGRATION_IMAGE_AUTO_REDUCE ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

function pickPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

export type WpImageSourceCandidate = {
  url: string;
  filesize?: number;
  variant: string;
};

/** WordPress REST sizes under `media_details.sizes` plus the full `source_url`. */
export function listWpImageSourceCandidates(item: WpMediaItem): WpImageSourceCandidate[] {
  const out: WpImageSourceCandidate[] = [];
  if (item.source_url?.trim()) {
    out.push({
      url: item.source_url.trim(),
      filesize: pickPositiveInt(item.media_details?.filesize),
      variant: "full",
    });
  }

  const sizes = item.media_details?.sizes;
  if (sizes && typeof sizes === "object" && !Array.isArray(sizes)) {
    for (const [variant, raw] of Object.entries(sizes)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as { source_url?: unknown; filesize?: unknown };
      const url = pickString(row.source_url);
      if (!url) continue;
      out.push({
        url,
        filesize: pickPositiveInt(row.filesize),
        variant,
      });
    }
  }

  return out;
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Largest WordPress derivative with a known `filesize` at or under the limit. */
export function pickBestWpImageSourceUnderLimit(
  candidates: WpImageSourceCandidate[],
  maxBytes: number
): WpImageSourceCandidate | undefined {
  const under = candidates.filter(
    (c) => c.filesize !== undefined && !exceedsImageSizeLimit(c.filesize, maxBytes)
  );
  if (under.length === 0) return undefined;
  return under.sort((a, b) => (b.filesize ?? 0) - (a.filesize ?? 0))[0];
}

export type PreparedImageBuffer = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  reduced: boolean;
  fromVariant: string;
  originalBytes: number;
  finalBytes: number;
};

function filenameForPreparedUpload(item: WpMediaItem, contentType: string): string {
  const base = filenameForMedia(item).replace(/\.[^.]+$/i, "");
  const ext =
    contentType.includes("jpeg") || contentType.includes("jpg")
      ? ".jpg"
      : extensionFromMimeType(contentType) || ".jpg";
  return `${base}${ext}`;
}

/**
 * Re-encode an image buffer until it fits under `maxBytes` (JPEG via jimp).
 */
export async function reduceImageBufferToMaxBytes(
  input: Buffer,
  maxBytes: number
): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  const image = await Jimp.read(input);
  let quality = 85;
  let width = image.width;
  const minWidth = 320;
  const originalWidth = image.width;

  for (let attempt = 0; attempt < 24; attempt++) {
    const work = image.clone();
    if (width < originalWidth) {
      work.resize({ w: Math.round(width) });
    }

    const buf = await work.getBuffer("image/jpeg", { quality });
    if (!exceedsImageSizeLimit(buf.length, maxBytes)) {
      return buf;
    }

    if (quality > 45) {
      quality -= 5;
    } else if (width > minWidth) {
      width = Math.floor(width * 0.85);
      quality = 80;
    } else {
      break;
    }
  }

  throw new Error(
    `could not reduce image below ${formatFileSizeBytes(maxBytes)} ` +
      `(original ${formatFileSizeBytes(input.length)})`
  );
}

/**
 * Fetch a WordPress attachment and return bytes at or under `maxBytes`.
 * Tries registered WP sizes first, then lossy re-encode via jimp.
 */
export async function prepareWpImageBufferUnderLimit(
  wp: WordPressClient,
  item: WpMediaItem,
  maxBytes?: number
): Promise<PreparedImageBuffer> {
  const max = maxBytes ?? loadMigrationImageMaxBytes();
  const candidates = listWpImageSourceCandidates(item);
  const best = pickBestWpImageSourceUnderLimit(candidates, max);
  const url = best?.url ?? item.source_url?.trim();
  if (!url) {
    throw new Error(`attachment ${item.id}: no image URL`);
  }

  const variant = best?.variant ?? "full";
  const { buffer, contentType } = await wp.fetchBinary(url);
  const originalBytes = buffer.length;

  if (!exceedsImageSizeLimit(buffer.length, max)) {
    return {
      buffer,
      contentType: contentType || item.mime_type || "image/jpeg",
      filename: filenameForMedia({ ...item, source_url: url }),
      reduced: variant !== "full",
      fromVariant: variant,
      originalBytes,
      finalBytes: buffer.length,
    };
  }

  const reduced = await reduceImageBufferToMaxBytes(buffer, max);
  const outType = "image/jpeg";
  return {
    buffer: reduced,
    contentType: outType,
    filename: filenameForPreparedUpload(item, outType),
    reduced: true,
    fromVariant: variant,
    originalBytes,
    finalBytes: reduced.length,
  };
}

export function wpMediaTitle(item: WpMediaItem): string {
  const fromTitle = item.title?.rendered ? stripHtml(item.title.rendered) : "";
  return (fromTitle || `wp-media-${item.id}`).slice(0, 250);
}
