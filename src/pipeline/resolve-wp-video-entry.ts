import type { PipelinePathsConfig } from "../config-pipeline.js";
import { MappingStore } from "../mapping-store.js";
import { readMediaSheet } from "../media/sheet.js";
import type { TrackingRow } from "./types.js";

export type ResolveVideoSource = "map" | "media_sheet" | "tracking";

export type ResolvedWpVideoEntry = {
  entryUid: string;
  source: ResolveVideoSource;
};

/**
 * Look up a migrated Contentstack video **entry** UID for a WordPress media attachment id.
 * (Videos are migrated as entries — see migrate-media-core `entry:video`.)
 */
export function resolveWpVideoEntryUid(opts: {
  attachmentId: number;
  map: MappingStore;
  mediaSheetPath: string;
  locale: string | undefined;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
}): ResolvedWpVideoEntry | undefined {
  const { attachmentId } = opts;
  if (attachmentId <= 0) return undefined;

  const mapped = opts.map.get("custom", attachmentId, opts.locale);
  if (mapped?.contentstackUid) {
    return { entryUid: mapped.contentstackUid, source: "map" };
  }

  const mediaRows = readMediaSheet(opts.mediaSheetPath);
  const mRow = mediaRows.find((m) => m.wp_id === attachmentId);
  if (
    mRow?.migration_status === "Pass" &&
    mRow.contentstack_type === "entry:video" &&
    mRow.contentstack_uid
  ) {
    opts.map.set({
      wpId: attachmentId,
      kind: "custom",
      contentstackUid: mRow.contentstack_uid,
      sourceKey: mRow.wp_slug,
      migratedAt: new Date().toISOString(),
      locale: opts.locale,
    });
    return { entryUid: mRow.contentstack_uid, source: "media_sheet" };
  }

  const mediaTab = opts.paths.mediaTabName;
  const trackHit = opts.allTracking.find(
    (r) =>
      r.row_kind === "media" &&
      r.wp_id === attachmentId &&
      r.source_sheet === mediaTab &&
      r.migration_status === "Pass" &&
      r.contentstack_entry_uid &&
      (r.content_type_uid?.includes("video") || r.migration_message?.includes("video"))
  );
  if (trackHit?.contentstack_entry_uid) {
    opts.map.set({
      wpId: attachmentId,
      kind: "custom",
      contentstackUid: trackHit.contentstack_entry_uid,
      sourceKey: trackHit.wp_slug || String(attachmentId),
      migratedAt: new Date().toISOString(),
      locale: opts.locale,
    });
    return { entryUid: trackHit.contentstack_entry_uid, source: "tracking" };
  }

  return undefined;
}
