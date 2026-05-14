import { initPipelineEnv } from "./args.js";
import { runExtractUrls } from "./extract-urls.js";
import { runMigrateBlogAuthorsFromTracking } from "./migrate-blog-authors.js";
import { runMigrateContentFromTracking, runMigrateMediaFromTracking } from "./migrate-from-tracking.js";
import { runPublishFromTracking } from "./publish.js";

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  initPipelineEnv(argv);

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.error(`Usage (always pass --env=... or --env-file=...):
  npm run pipeline:extract -- --env=stack-a
  npm run pipeline:migrate-media -- --env=stack-a [--mode=all|single|ids|failed] [--limit=25] [--offset=0] [--ids=1,2]
  npm run pipeline:migrate-content -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=1,2]
  npm run pipeline:migrate-blog-authors -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=365]
  npm run pipeline:publish -- --env=stack-a [--publish-mode=bulk-status|wp-ids|cs-uids] [--filter-migration-status=Pass] [--filter-publish-status=Unpublished] [--wp-ids=1,2] [--cs-uids=uid1,uid2] [--limit=100]

Env (see env/.env.migration-pipeline.example):
  MIGRATION_SOURCE_WORKBOOK, MIGRATION_TRACKING_WORKBOOK, MIGRATION_TRACKING_SHEET,
  MIGRATION_MEDIA_TAB_NAME, MIGRATION_WP_REST_PATH, MIGRATION_START_SHEET,
  MIGRATION_CONTENT_TYPE_UID, MONGODB_URI, MONGODB_COLLECTION, MIGRATION_RUN_ID,
  CONTENTSTACK_PUBLISH_ENVIRONMENTS, CONTENTSTACK_PUBLISH_LOCALES, CS_FEATURED_IMAGE_FIELD_UID,
  story_author→blog_author: CS_CONTENT_TYPE_BLOG_AUTHOR, BLOG_AUTHOR_FIELD_*
`);
    process.exit(0);
  }

  if (cmd === "extract") await runExtractUrls(rest);
  else if (cmd === "migrate-media") await runMigrateMediaFromTracking(rest);
  else if (cmd === "migrate-content") await runMigrateContentFromTracking(rest);
  else if (cmd === "migrate-blog-authors") await runMigrateBlogAuthorsFromTracking(rest);
  else if (cmd === "publish") await runPublishFromTracking(rest);
  else throw new Error(`Unknown pipeline command: ${cmd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
