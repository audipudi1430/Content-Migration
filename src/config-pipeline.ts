import { resolve } from "node:path";

export type MongoConfig = {
  uri: string | undefined;
  dbName: string | undefined;
  collection: string;
  enabled: boolean;
};

export function loadMongoConfig(): MongoConfig {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
  const collection =
    process.env.MONGODB_COLLECTION ?? process.env.MIGRATION_MONGO_COLLECTION ?? "migration_tracking";
  const dbName = process.env.MONGODB_DB_NAME ?? undefined;
  return { uri, dbName, collection, enabled: Boolean(uri && uri.length > 0) };
}

export type PipelinePathsConfig = {
  sourceWorkbook: string;
  trackingWorkbook: string;
  trackingSheet: string;
  mediaTabName: string;
  /** WordPress REST collection path for the content being migrated (e.g. /wp-json/wp/v2/posts). */
  wpRestPath: string;
  /** Workbook tab that lists URLs to migrate for this run (must match a tab name in the source workbook for extraction). */
  migrateStartSheet: string;
  /** Contentstack content type UID for created entries. */
  contentTypeUid: string;
  /** Logical run id for MongoDB / reporting (separate stacks can share a DB with different run ids). */
  runId: string;
  /** Optional label for dashboards (e.g. stack-a). */
  envLabel: string;
  featuredImageFieldUid: string | undefined;
  publishEnvironments: string[];
  publishLocales: string[];
};

export function loadPipelinePaths(): PipelinePathsConfig {
  const publishEnvs = (process.env.CONTENTSTACK_PUBLISH_ENVIRONMENTS ?? "production")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const publishLocales = (process.env.CONTENTSTACK_PUBLISH_LOCALES ?? process.env.CONTENTSTACK_LOCALE ?? "en-us")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    sourceWorkbook: resolve(process.env.MIGRATION_SOURCE_WORKBOOK ?? "migration-source.xlsx"),
    trackingWorkbook: resolve(process.env.MIGRATION_TRACKING_WORKBOOK ?? "migration-tracking.xlsx"),
    trackingSheet: process.env.MIGRATION_TRACKING_SHEET ?? "migration_tracking",
    mediaTabName: process.env.MIGRATION_MEDIA_TAB_NAME ?? "media",
    wpRestPath: (process.env.MIGRATION_WP_REST_PATH ?? "/wp-json/wp/v2/posts").replace(/\/$/, ""),
    migrateStartSheet: process.env.MIGRATION_START_SHEET ?? "posts",
    contentTypeUid:
      process.env.MIGRATION_CONTENT_TYPE_UID ?? process.env.CS_CONTENT_TYPE_POST ?? "",
    runId: process.env.MIGRATION_RUN_ID ?? "default",
    envLabel: process.env.MIGRATION_ENV_LABEL ?? "",
    featuredImageFieldUid: process.env.CS_FEATURED_IMAGE_FIELD_UID?.trim() || undefined,
    publishEnvironments: publishEnvs.length ? publishEnvs : ["production"],
    publishLocales: publishLocales.length ? publishLocales : ["en-us"],
  };
}
