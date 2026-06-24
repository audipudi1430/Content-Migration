import type { ContentstackManagementClient } from "../contentstack/client.js";
import { fetchWpMediaItem } from "../media/migrate-media-core.js";
import type { WordPressClient } from "../wordpress/client.js";

/** Default 0.3 MiB (314572 bytes). Override with `MIGRATION_IMAGE_MAX_BYTES`. */
export function loadMigrationImageMaxBytes(): number {
  const raw =
    process.env.MIGRATION_IMAGE_MAX_BYTES?.trim() ||
    process.env.BLOG_FILE_FIELD_MAX_BYTES?.trim() ||
    String(Math.floor(0.3 * 1024 * 1024));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.floor(0.3 * 1024 * 1024);
}

export function formatFileSizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function exceedsImageSizeLimit(bytes: number, maxBytes?: number): boolean {
  const max = maxBytes ?? loadMigrationImageMaxBytes();
  return Number.isFinite(bytes) && bytes > max;
}

function pickPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/** WordPress attachment size from REST `media_details.filesize`. */
export async function wpAttachmentFileSizeBytes(
  wp: WordPressClient,
  attachmentId: number
): Promise<number | undefined> {
  if (attachmentId <= 0) return undefined;
  try {
    const item = await fetchWpMediaItem(wp, attachmentId);
    const fromDetails = (item as { media_details?: { filesize?: unknown } }).media_details?.filesize;
    const n = pickPositiveInt(fromDetails);
    if (n) return n;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Contentstack asset `file_size` when the asset already exists in the stack. */
export async function csAssetFileSizeBytes(
  cs: ContentstackManagementClient,
  assetUid: string
): Promise<number | undefined> {
  try {
    return await cs.getAssetFileSizeBytes(assetUid);
  } catch {
    return undefined;
  }
}

export function imageOversizedWarning(
  purpose: string,
  wpId: number,
  bytes: number,
  maxBytes?: number
): string {
  const max = maxBytes ?? loadMigrationImageMaxBytes();
  return (
    `Skipped image wp_id=${wpId} (${purpose}): ` +
    `${formatFileSizeBytes(bytes)} exceeds ${formatFileSizeBytes(max)} limit`
  );
}

/** Collect non-fatal migration warnings (stored on tracking `migration_message`). */
export class MigrationWarnings {
  private readonly items: string[] = [];

  add(msg: string): void {
    const t = msg.trim();
    if (!t) return;
    this.items.push(t);
  }

  join(separator = "; "): string {
    return this.items.join(separator);
  }

  /** True when a size-limit skip was recorded for this WordPress attachment id. */
  hasSizeSkipFor(wpId: number): boolean {
    const id = String(wpId);
    return this.items.some(
      (msg) => msg.includes(`wp_id=${id}`) && /exceeds.*limit|maximum size limit/i.test(msg)
    );
  }

  get count(): number {
    return this.items.length;
  }
}

export function mergeMigrationMessages(...parts: (string | undefined)[]): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join("; ");
}
