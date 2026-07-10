import type { ContentstackManagementClient } from "../contentstack/client.js";
import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import type { MigrationWarnings } from "./image-size-limit.js";
import { resolveWpVideoEntryUid } from "./resolve-wp-video-entry.js";
import { isTitleNotUniqueError } from "./seo-social-payload.js";
import type { TrackingRow } from "./types.js";
import { buildVideoEntryPayload, parseVideoEmbed } from "./video-embed.js";
import { loadVideoContentTypeUid, loadVideoFieldUids } from "./video-entry-config.js";

export type EnsureVideoEntrySource = "map" | "media_sheet" | "tracking" | "created" | "existing";

export type EnsureVideoEntryResult = {
  entryUid: string;
  source: EnsureVideoEntrySource;
};

async function createVideoEntryWithDuplicateFallback(
  cs: ContentstackManagementClient,
  contentTypeUid: string,
  payload: Record<string, unknown> & { title: string },
  locale: string | undefined,
  purpose: string
): Promise<{ uid: string; reused: boolean }> {
  const existing = await cs.findEntryUidsByExactTitle(contentTypeUid, payload.title, locale);
  if (existing.length > 0) {
    const existingUid = existing[0]!;
    console.error(
      `[video] ${purpose} reusing existing entry ${existingUid} (title="${payload.title}")`
    );
    return { uid: existingUid, reused: true };
  }

  try {
    const created = await cs.createEntry(contentTypeUid, payload, locale);
    return { uid: created.uid, reused: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isTitleNotUniqueError(msg)) throw e;
    const matches = await cs.findEntryUidsByExactTitle(contentTypeUid, payload.title, locale);
    if (matches.length === 0) throw e;
    const existingUid = matches[0]!;
    console.error(
      `[video] ${purpose} reusing existing entry ${existingUid} after duplicate title (no update)`
    );
    return { uid: existingUid, reused: true };
  }
}

/**
 * Resolve or create a Contentstack `video` entry for a body `core/embed` block.
 * - WP attachment id → existing media migration map
 * - Embed URL → map by stable key, else create YouTube/Brightcove entry
 */
export async function ensureVideoEntryForBody(opts: {
  attachmentId?: number;
  embedUrl?: string;
  providerSlug?: string;
  purpose: string;
  cs: ContentstackManagementClient;
  map: MappingStore;
  mediaSheetPath: string;
  locale: string | undefined;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
  warnings?: MigrationWarnings;
}): Promise<EnsureVideoEntryResult | undefined> {
  const { attachmentId, embedUrl, providerSlug, purpose, cs, map, locale } = opts;

  if (attachmentId && attachmentId > 0) {
    const resolved = resolveWpVideoEntryUid({
      attachmentId,
      map,
      mediaSheetPath: opts.mediaSheetPath,
      locale,
      paths: opts.paths,
      allTracking: opts.allTracking,
    });
    if (resolved) {
      return { entryUid: resolved.entryUid, source: resolved.source };
    }
  }

  const rawUrl = embedUrl?.trim();
  if (!rawUrl) return undefined;

  const parsed = parseVideoEmbed(rawUrl, providerSlug);
  if (!parsed) {
    const msg =
      `unsupported embed URL for video entry (provider=${providerSlug || "unknown"}): ${rawUrl}`;
    opts.warnings?.add(msg);
    console.error(`[video] ${purpose} skipped: ${msg}`);
    return undefined;
  }

  const mapped = map.get("custom", 0, locale, parsed.mapSourceKey);
  if (mapped?.contentstackUid) {
    return { entryUid: mapped.contentstackUid, source: "map" };
  }

  const contentTypeUid = loadVideoContentTypeUid();
  const fields = loadVideoFieldUids();
  const payload = buildVideoEntryPayload(parsed, fields) as Record<string, unknown> & {
    title: string;
  };

  try {
    const { uid: entryUid, reused } = await createVideoEntryWithDuplicateFallback(
      cs,
      contentTypeUid,
      payload,
      locale,
      purpose
    );
    map.set({
      wpId: 0,
      kind: "custom",
      contentstackUid: entryUid,
      sourceKey: parsed.mapSourceKey,
      migratedAt: new Date().toISOString(),
      locale,
    });
    await map.save();
    console.error(
      `[video] ${purpose} ${reused ? "REUSED" : "CREATED"} entry ${entryUid} type=${parsed.kind} ` +
        `title=${parsed.entryTitle} url=${parsed.embedUrl}`
    );
    return { entryUid, source: reused ? "existing" : "created" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.warnings?.add(`video entry: ${msg.slice(0, 300)}`);
    console.error(`[video] ${purpose} FAIL: ${msg.slice(0, 400)}`);
    return undefined;
  }
}

export async function tryResolveVideoEntryForBody(
  opts: Parameters<typeof ensureVideoEntryForBody>[0]
): Promise<string | undefined> {
  const result = await ensureVideoEntryForBody(opts);
  return result?.entryUid;
}
