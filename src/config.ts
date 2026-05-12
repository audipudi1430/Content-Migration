import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

/**
 * Load from process.env. Use a secrets manager in production.
 */
export function loadConfig() {
  const wpBaseUrl = process.env.WP_BASE_URL;
  const wpAppPassword = process.env.WP_APPLICATION_PASSWORD;
  const wpUser = process.env.WP_USER;

  const csApiKey = process.env.CONTENTSTACK_MANAGEMENT_TOKEN;
  const csApiHost = process.env.CONTENTSTACK_API_HOST ?? "api.contentstack.io";
  const stackApiKey = process.env.CONTENTSTACK_STACK_API_KEY;

  const missing: string[] = [];
  if (!wpBaseUrl) missing.push("WP_BASE_URL");
  if (!csApiKey) missing.push("CONTENTSTACK_MANAGEMENT_TOKEN");
  if (!stackApiKey) missing.push("CONTENTSTACK_STACK_API_KEY");

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  return {
    wp: {
      baseUrl: wpBaseUrl!.replace(/\/$/, ""),
      user: wpUser,
      applicationPassword: wpAppPassword,
    },
    contentstack: {
      managementToken: csApiKey!,
      apiHost: csApiHost,
      stackApiKey: stackApiKey!,
    },
    mappingFile: resolve(process.env.MIGRATION_MAP_PATH ?? "migration-map.json"),
  };
}

/** WordPress → Contentstack asset batching (env-controlled). */
export function loadAssetMigrationSettings() {
  const batchRaw = process.env.MEDIA_BATCH_SIZE ?? "25";
  const batchSize = Math.max(1, Number(batchRaw) || 25);
  const overrideRaw = process.env.MEDIA_OFFSET_OVERRIDE;
  const parsedOverride =
    overrideRaw !== undefined && overrideRaw !== ""
      ? Number(overrideRaw)
      : undefined;
  return {
    batchSize,
    offsetOverride:
      parsedOverride !== undefined && !Number.isNaN(parsedOverride) ? parsedOverride : undefined,
    folderName: process.env.CS_ASSET_FOLDER_NAME ?? "WordPress Media",
    parentFolderUid: process.env.CS_ASSET_PARENT_FOLDER_UID,
  };
}

export function initEnvFromArgs(argv: string[]): void {
  const envFileArg = argv.find((a) => a.startsWith("--env-file="));
  const envNameArg = argv.find((a) => a.startsWith("--env="));
  const envName = envNameArg ? envNameArg.slice("--env=".length).trim() : "";

  const explicitPath = envFileArg ? envFileArg.slice("--env-file=".length).trim() : "";
  const inferredPath = envName ? `env/.env.${envName}` : "";
  const path = explicitPath || inferredPath || ".env";

  loadDotenv({ path, override: true });
}
