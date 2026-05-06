import type { MappingStore } from "../mapping-store.js";
import type { ContentstackManagementClient } from "../contentstack/client.js";
import type { WordPressClient } from "../wordpress/client.js";

/** Content type UIDs in your stack — set via env or constants */
export type ContentModelUids = {
  category?: string;
  tag?: string;
  assetParentFolderUid?: string;
  post?: string;
  page?: string;
};

export type AssetMigrationSettings = {
  /** Max new uploads per run (already-mapped items are skipped but still advance the list cursor). */
  batchSize: number;
  /** If set, overrides stored wpMediaListOffset for this run only (e.g. reset to 0). */
  offsetOverride?: number;
  /** Folder name in Contentstack when no folder UID exists yet */
  folderName: string;
  /** Optional parent folder UID in Contentstack when creating the migration folder */
  parentFolderUid?: string;
};

export type MigrationContext = {
  wp: WordPressClient;
  cs: ContentstackManagementClient;
  map: MappingStore;
  uids: ContentModelUids;
  locale?: string;
  assetMigration?: AssetMigrationSettings;
};

export type MigrationPhase = {
  name: string;
  run: (ctx: MigrationContext) => Promise<void>;
};
