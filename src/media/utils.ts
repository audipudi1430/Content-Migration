import { extensionFromMimeType } from "./mime.js";
import type { WpMediaItem } from "./types.js";

export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim() || s;
}

export function filenameForMedia(item: WpMediaItem): string {
  try {
    const seg = new URL(item.source_url).pathname.split("/").filter(Boolean).pop();
    if (seg && seg.includes(".")) return decodeURIComponent(seg);
  } catch {
    // ignore and use fallback
  }
  const ext = extensionFromMimeType(item.mime_type) || ".bin";
  const base = (item.slug || `wp-media-${item.id}`).replace(/[/\\?%*:|"<>]/g, "-");
  return `${base}${ext}`;
}

export function stringArg(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

export function numberArg(argv: string[], name: string): number | undefined {
  const raw = stringArg(argv, name);
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
