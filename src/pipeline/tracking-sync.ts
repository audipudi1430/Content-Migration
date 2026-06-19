import type { MongoConfig, PipelinePathsConfig } from "../config-pipeline.js";
import { upsertTrackingDoc, trackingDocId, getTrackingCollection } from "../mongo/tracking-repository.js";
import type { MigrationTrackingDoc } from "../mongo/tracking-repository.js";
import {
  readAllTrackingRowsFromWorkbook,
  readTrackingSheet,
  writeTrackingWorkbook,
  trackingRowMergeKey,
} from "./tracking-io.js";
import { categoryRowDisambiguator, categoryRowHasSheetData } from "./blog-category-sheet.js";
import type { TrackingRow } from "./types.js";

function rowKey(r: TrackingRow): string {
  return trackingRowMergeKey(r);
}

export function trackingRowToMongoDoc(
  paths: PipelinePathsConfig,
  row: TrackingRow,
  updatedAt: string
): MigrationTrackingDoc {
  return {
    _id: trackingDocId(
      paths.runId,
      row.source_sheet,
      row.row_kind,
      row.wp_id || 0,
      row.url,
      row.wp_id === 0 && !row.url && categoryRowHasSheetData(row)
        ? categoryRowDisambiguator(row)
        : undefined
    ),
    runId: paths.runId,
    envLabel: paths.envLabel,
    sourceSheet: row.source_sheet,
    rowKind: row.row_kind,
    url: row.url,
    newUrl: row.new_url || undefined,
    wpId: row.wp_id,
    wpRestPath: row.wp_rest_path,
    contentTypeUid: row.content_type_uid || undefined,
    featuredMediaWpId: row.featured_media_wp_id ? Number(row.featured_media_wp_id) : undefined,
    migrationStatus: row.migration_status,
    publishStatus: row.publish_status,
    contentstackEntryUid: row.contentstack_entry_uid || undefined,
    contentstackAssetUid: row.contentstack_asset_uid || undefined,
    migrationMessage: row.migration_message || undefined,
    publishedAt: row.published_at || undefined,
    updatedAt,
    sourceColumnsJson: row.source_columns_json || undefined,
    extractedAt: row.extracted_at || undefined,
    targetUrl: row.target_url || undefined,
    wpSlug: row.wp_slug || undefined,
    wpTitle: row.wp_title || undefined,
    wpStatus: row.wp_status || undefined,
    wpType: row.wp_type || undefined,
    wpLink: row.wp_link || undefined,
    wpExtractJson: row.wp_extract_json || undefined,
  };
}

export async function persistOneRow(
  paths: PipelinePathsConfig,
  allRows: TrackingRow[],
  row: TrackingRow,
  mongoCfg: MongoConfig
): Promise<void> {
  const k = rowKey(row);
  const idx = allRows.findIndex((r) => rowKey(r) === k);
  if (idx >= 0) allRows[idx] = row;
  const perTab =
    process.env.MIGRATION_TRACKING_PER_TAB_SHEETS !== "0" &&
    Boolean(row.source_sheet?.trim());
  writeTrackingWorkbook(paths.trackingWorkbook, paths.trackingSheet, allRows, perTab);
  const coll = await getTrackingCollection(mongoCfg);
  if (!coll) return;
  const now = new Date().toISOString();
  await upsertTrackingDoc(coll, trackingRowToMongoDoc(paths, row, now));
}

export function loadAllTracking(paths: PipelinePathsConfig): TrackingRow[] {
  const all = readAllTrackingRowsFromWorkbook(paths.trackingWorkbook);
  if (all.length > 0) return all;
  return readTrackingSheet(paths.trackingWorkbook, paths.trackingSheet);
}
