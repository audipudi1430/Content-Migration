import type { MediaKind } from "./types.js";

const IMAGE_PREFIX = "image/";
const VIDEO_PREFIX = "video/";

export function kindFromMimeType(mimeType: string): MediaKind {
  const mime = mimeType.toLowerCase().trim();
  if (mime.startsWith(IMAGE_PREFIX)) return "image";
  if (mime.startsWith(VIDEO_PREFIX)) return "video";
  if (mime === "application/pdf") return "document";
  return "other";
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

export function extensionFromMimeType(mimeType: string): string {
  return MIME_EXT[mimeType.toLowerCase()] ?? "";
}
