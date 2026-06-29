import sharp from "sharp";
import { extensionFromMimeType } from "../media/mime.js";
import { formatFileSizeBytes, loadMigrationImageMaxBytes } from "./image-size-limit.js";

export type PreparedImageUpload = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  compressed: boolean;
  originalBytes: number;
  outputBytes: number;
  warning?: string;
};

const COMPRESSIBLE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
]);

function normalizeMime(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]!.trim();
}

export function isCompressibleImageMime(contentType: string): boolean {
  return COMPRESSIBLE_MIMES.has(normalizeMime(contentType));
}

function replaceFilenameExtension(filename: string, contentType: string): string {
  const ext = extensionFromMimeType(contentType);
  if (!ext) return filename;
  const base = filename.replace(/\.[^.]+$/, "") || filename;
  return `${base}${ext}`;
}

async function encodeImage(
  pipeline: sharp.Sharp,
  mime: string,
  quality: number
): Promise<{ buffer: Buffer; contentType: string }> {
  const normalized = normalizeMime(mime);
  if (normalized === "image/png") {
    const buffer = await pipeline
      .png({ compressionLevel: 9, palette: quality <= 55 })
      .toBuffer();
    return { buffer, contentType: "image/png" };
  }
  if (normalized === "image/webp") {
    const buffer = await pipeline.webp({ quality }).toBuffer();
    return { buffer, contentType: "image/webp" };
  }
  const buffer = await pipeline
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return { buffer, contentType: "image/jpeg" };
}

function compressionWarning(
  originalBytes: number,
  outputBytes: number,
  maxBytes: number,
  note?: string
): string {
  const detail = note ? ` (${note})` : "";
  return (
    `Compressed image from ${formatFileSizeBytes(originalBytes)} to ${formatFileSizeBytes(outputBytes)} ` +
    `(limit ${formatFileSizeBytes(maxBytes)})${detail}`
  );
}

/**
 * Reduce raster images above the migration size limit (default 307 KB) to fit within range.
 * Returns the original buffer when already within limit or not compressible.
 */
export async function prepareImageUploadBuffer(opts: {
  buffer: Buffer;
  contentType: string;
  filename: string;
  maxBytes?: number;
}): Promise<PreparedImageUpload> {
  const maxBytes = opts.maxBytes ?? loadMigrationImageMaxBytes();
  const originalBytes = opts.buffer.length;
  const base: PreparedImageUpload = {
    buffer: opts.buffer,
    contentType: opts.contentType,
    filename: opts.filename,
    compressed: false,
    originalBytes,
    outputBytes: originalBytes,
  };

  if (originalBytes <= maxBytes) return base;

  const mime = normalizeMime(opts.contentType);
  if (!isCompressibleImageMime(mime)) {
    return {
      ...base,
      warning:
        `Image ${formatFileSizeBytes(originalBytes)} exceeds ${formatFileSizeBytes(maxBytes)} ` +
        `and mime ${mime} cannot be compressed`,
    };
  }

  let pipeline = sharp(opts.buffer, { failOn: "none" }).rotate();
  const meta = await pipeline.metadata();
  let bestBuffer = opts.buffer;
  let bestType = opts.contentType;
  let bestSize = originalBytes;

  const qualities = [85, 75, 65, 55, 45, 35, 25];
  for (const quality of qualities) {
    const encoded = await encodeImage(pipeline.clone(), mime, quality);
    if (encoded.buffer.length < bestSize) {
      bestBuffer = encoded.buffer;
      bestType = encoded.contentType;
      bestSize = encoded.buffer.length;
    }
    if (encoded.buffer.length <= maxBytes) {
      return {
        buffer: encoded.buffer,
        contentType: encoded.contentType,
        filename: replaceFilenameExtension(opts.filename, encoded.contentType),
        compressed: true,
        originalBytes,
        outputBytes: encoded.buffer.length,
        warning: compressionWarning(originalBytes, encoded.buffer.length, maxBytes),
      };
    }
  }

  const startWidth = meta.width ?? 1600;
  const startHeight = meta.height ?? 1200;
  let width = startWidth;
  let height = startHeight;

  while (width >= 320 && height >= 240) {
    width = Math.max(320, Math.floor(width * 0.85));
    height = Math.max(240, Math.floor(height * 0.85));
    const resized = pipeline.clone().resize({ width, height, fit: "inside", withoutEnlargement: true });

    for (const quality of qualities) {
      const encoded = await encodeImage(resized, mime, quality);
      if (encoded.buffer.length < bestSize) {
        bestBuffer = encoded.buffer;
        bestType = encoded.contentType;
        bestSize = encoded.buffer.length;
      }
      if (encoded.buffer.length <= maxBytes) {
        return {
          buffer: encoded.buffer,
          contentType: encoded.contentType,
          filename: replaceFilenameExtension(opts.filename, encoded.contentType),
          compressed: true,
          originalBytes,
          outputBytes: encoded.buffer.length,
          warning: compressionWarning(originalBytes, encoded.buffer.length, maxBytes, `resized to ${width}px`),
        };
      }
    }
  }

  if (bestSize < originalBytes) {
    return {
      buffer: bestBuffer,
      contentType: bestType,
      filename: replaceFilenameExtension(opts.filename, bestType),
      compressed: true,
      originalBytes,
      outputBytes: bestSize,
      warning:
        compressionWarning(originalBytes, bestSize, maxBytes, "best effort") +
        (bestSize > maxBytes ? `; still exceeds limit` : ""),
    };
  }

  return {
    ...base,
    warning:
      `Image ${formatFileSizeBytes(originalBytes)} exceeds ${formatFileSizeBytes(maxBytes)} ` +
      `and could not be compressed enough`,
  };
}
