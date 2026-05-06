export type WpMediaItem = {
  id: number;
  source_url: string;
  slug: string;
  mime_type: string;
  title?: { rendered?: string };
};

export type MediaKind = "image" | "video" | "document" | "other";

export type MigrationStatus = "Pending" | "Pass" | "Fail" | "Skipped";

export type MediaSheetRow = {
  wp_id: number;
  mime_type: string;
  media_kind: MediaKind;
  wp_slug: string;
  wp_source_url: string;
  wp_title: string;
  migration_status: MigrationStatus;
  contentstack_uid: string;
  contentstack_type: string;
  migration_message: string;
  migrated_at: string;
};
