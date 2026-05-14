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

/**
 * Parses `sheet=value;sheet2=value2` (semicolon between pairs). Whitespace trimmed.
 * Used for per-tab WordPress REST paths and Contentstack content type UIDs.
 */
export function parseSheetEqualsMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw?.trim()) return out;
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const sheet = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (sheet && value) out[sheet] = value;
  }
  return out;
}

export type PipelinePathsConfig = {
  sourceWorkbook: string;
  trackingWorkbook: string;
  trackingSheet: string;
  mediaTabName: string;
  /** WordPress REST collection path for the content being migrated (e.g. /wp-json/wp/v2/posts). */
  wpRestPath: string;
  /**
   * Per source-sheet tab: WordPress REST collection path (e.g. categories=/wp-json/wp/v2/story_category).
   * Keys must match Excel tab names exactly. Overrides `wpRestPath` for that tab during extract.
   */
  sheetWpRestPathByTab: Record<string, string>;
  /**
   * Per source-sheet tab: Contentstack content type UID for tracking rows from that tab.
   * Overrides `contentTypeUid` when set (semicolon-separated sheet=uid pairs).
   */
  sheetContentTypeUidByTab: Record<string, string>;
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
    sheetWpRestPathByTab: parseSheetEqualsMap(process.env.MIGRATION_SHEET_WP_REST_PATHS),
    sheetContentTypeUidByTab: parseSheetEqualsMap(process.env.MIGRATION_SHEET_CONTENT_TYPE_UID),
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

/** WordPress REST base path for a source workbook tab (media tab is always `/wp-json/wp/v2/media`). */
export function wpRestPathForSourceTab(
  paths: PipelinePathsConfig,
  tabName: string,
  rowKind: "media" | "content"
): string {
  if (rowKind === "media") return "/wp-json/wp/v2/media";
  const override = paths.sheetWpRestPathByTab[tabName]?.trim();
  if (override) return override.replace(/\/$/, "");
  return paths.wpRestPath;
}

/** Contentstack content type UID stored on tracking rows for this tab (empty for media). */
export function contentTypeUidForSourceTab(
  paths: PipelinePathsConfig,
  tabName: string,
  rowKind: "media" | "content"
): string {
  if (rowKind === "media") return "";
  const override = paths.sheetContentTypeUidByTab[tabName]?.trim();
  if (override) return override;
  return paths.contentTypeUid;
}
