export type TrackingRowKind = "content" | "media";

export type TrackingMigrationStatus = "Pending" | "Pass" | "Fail" | "Skipped" | "NoWpId";
export type TrackingPublishStatus = "Unpublished" | "Published" | "Fail";

export type TrackingRow = {
  source_sheet: string;
  row_kind: TrackingRowKind;
  url: string;
  wp_id: number;
  /** WordPress REST collection path used when migrating this row */
  wp_rest_path: string;
  content_type_uid: string;
  featured_media_wp_id: string;
  migration_status: TrackingMigrationStatus;
  publish_status: TrackingPublishStatus;
  contentstack_entry_uid: string;
  contentstack_asset_uid: string;
  migration_message: string;
  published_at: string;
  updated_at: string;
  /** JSON: all columns from the source Excel row at last extract (header → value). */
  source_columns_json: string;
  /** ISO time when this row was last written by extract. */
  extracted_at: string;
  /** Contentstack CMA URL for the created entry or asset after Pass (empty otherwise). */
  target_url: string;
};

export function emptyTrackingRow(partial: Partial<TrackingRow> & Pick<TrackingRow, "source_sheet" | "row_kind" | "url">): TrackingRow {
  const now = new Date().toISOString();
  return {
    source_sheet: partial.source_sheet,
    row_kind: partial.row_kind,
    url: partial.url,
    wp_id: partial.wp_id ?? 0,
    wp_rest_path: partial.wp_rest_path ?? "",
    content_type_uid: partial.content_type_uid ?? "",
    featured_media_wp_id: partial.featured_media_wp_id ?? "",
    migration_status: partial.migration_status ?? "Pending",
    publish_status: partial.publish_status ?? "Unpublished",
    contentstack_entry_uid: partial.contentstack_entry_uid ?? "",
    contentstack_asset_uid: partial.contentstack_asset_uid ?? "",
    migration_message: partial.migration_message ?? "",
    published_at: partial.published_at ?? "",
    updated_at: partial.updated_at ?? now,
    source_columns_json: partial.source_columns_json ?? "",
    extracted_at: partial.extracted_at ?? "",
    target_url: partial.target_url ?? "",
  };
}
