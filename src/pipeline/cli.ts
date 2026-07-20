import { initPipelineEnv } from "./args.js";
import { runExtractContentImages } from "./extract-content-images.js";
import { runExtractContentVideos } from "./extract-content-videos.js";
import { runExtractUrls } from "./extract-urls.js";
import { runMigrateBlogStoriesFromTracking } from "./migrate-blog-stories.js";
import { runMigrateBlogAuthorsFromTracking } from "./migrate-blog-authors.js";
import { runMigrateBlogCategoriesFromTracking } from "./migrate-blog-categories.js";
import { runMigrateContentFromTracking, runMigrateMediaFromTracking } from "./migrate-from-tracking.js";
import { runAddToReleaseFromTracking } from "./add-to-release.js";
import { runPublishFromTracking } from "./publish.js";
import { runUploadFolderImages } from "./upload-folder-images.js";
import { runUpdateEntryUrls } from "./update-entry-urls.js";
import { runUpdateStoryDatelines } from "./update-story-datelines.js";
import { runUpdateBConnectedStories } from "./update-bconnected-stories.js";
import { runMigratePressReleasesFromTracking } from "./migrate-press-releases.js";

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  initPipelineEnv(argv);

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.error(`Usage (always pass --env=... or --env-file=...):
  npm run pipeline:extract -- --env=stack-a [--tab=blog_author] [--concurrency=8] [--per-tab-tracking=1]
  npm run pipeline:extract-content-images -- --env=stack-a --tab=stories [--concurrency=8] [--output-workbook=content-images-stories.xlsx]
  npm run pipeline:extract-content-videos -- --env=stack-a --tab=stories [--concurrency=8] [--output-workbook=content-videos-stories.xlsx]
  npm run pipeline:migrate-media -- --env=stack-a [--mode=all|single|ids|failed] [--limit=25] [--offset=0] [--ids=1,2]
  npm run pipeline:migrate-content -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=1,2]
  npm run pipeline:migrate-blog-authors -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=365] [--update]
  npm run pipeline:migrate-blog-categories -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=1,2] [--update]
  npm run pipeline:migrate-blog-stories -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=1,2] [--update]
  npm run pipeline:migrate-press-releases -- --env=stack-a [--mode=all|single|ids|failed] [--limit=10] [--ids=42788] [--update]
  npm run pipeline:publish -- --env=stack-a [--publish-mode=bulk-status|wp-ids|cs-uids] [--filter-migration-status=Pass] [--filter-publish-status=Unpublished] [--wp-ids=1,2] [--cs-uids=uid1,uid2] [--limit=100]
  npm run pipeline:add-to-release -- --env=stack-a [--tab=stories] [--release-name=My Release] [--filter-migration-status=Pass] [--release-action=publish] [--limit=5000]
  npm run pipeline:upload-folder-images -- --env=stack-a --folder=D:/photos/parent [--concurrency=4] [--no-skip-pass]
  npm run pipeline:update-entry-urls -- --env=stack-a [--workbook=entry-url-updates.xlsx] [--mode=all|single|ids] [--uid=blt...] [--uids=uid1,uid2] [--content-type=blog] [--locale=en-us] [--concurrency=4] [--no-skip-pass]
  npm run pipeline:update-story-datelines -- --env=stack-a [--mode=all|single|ids] [--single-id=123] [--ids=1,2] [--limit=50] [--concurrency=4]
  npm run pipeline:update-story-datelines -- --env=stack-a --workbook=datelines.xlsx [--tab=Sheet1] [--content-type=blog] [--no-skip-pass]
  # workbook writes *-tracking.xlsx (url, new_url, contentstack_entry_uid, Pass/Fail); mode=all = all rows (not 25)
  npm run pipeline:update-bconnected-stories -- --env=stack-a --workbook=b-connected.xlsx [--tab=final] [--offset=0] [--limit=20] [--concurrency=4] [--all] [--no-skip-pass]
  # pending-only; find by url else new_url→Already Updated; default limit=20 concurrency=4 (avoid CMA 429); writes *-tracking.xlsx

Env (see env/.env.migration-pipeline.example):
  MIGRATION_SOURCE_WORKBOOK, MIGRATION_TRACKING_WORKBOOK, MIGRATION_TRACKING_SHEET,
  MIGRATION_MEDIA_TAB_NAME, MIGRATION_WP_REST_PATH, MIGRATION_START_SHEET,
  MIGRATION_SHEET_WP_REST_PATHS (per-tab WP REST, e.g. categories=/wp-json/wp/v2/story_category;blog_author=/wp-json/wp/v2/story_author),
  MIGRATION_SHEET_CONTENT_TYPE_UID (per-tab Contentstack UID, same sheet=value;... format),
  MIGRATION_CONTENT_TYPE_UID, MONGODB_URI, MONGODB_COLLECTION, MIGRATION_RUN_ID, MIGRATION_MICROSITE,
  MIGRATION_EXTRACT_TAB, MIGRATION_EXTRACT_CONCURRENCY, MIGRATION_TRACKING_PER_TAB_SHEETS,
  MIGRATION_EXTRACT_SKIP_WP_ENRICH, MIGRATION_WP_EXTRACT_JSON_MAX_BYTES,
  CONTENTSTACK_PUBLISH_ENVIRONMENTS, CONTENTSTACK_PUBLISH_LOCALES, CONTENTSTACK_RELEASE_NAME, PAGE_OWNER,
  CONTENTSTACK_ENTRY_TARGET_URL_TEMPLATE, CONTENTSTACK_ASSET_TARGET_URL_TEMPLATE,
  story_author→blog_author: CS_CONTENT_TYPE_BLOG_AUTHOR, BLOG_AUTHOR_FIELD_*, BLOG_AUTHOR_UPDATE, --update
  story_category→blog_category: CS_CONTENT_TYPE_BLOG_CATEGORY, BLOG_CATEGORY_FIELD_*, BLOG_CATEGORY_URL_LANGUAGE, BLOG_CATEGORY_UPDATE, --update
  story→blog: CS_CONTENT_TYPE_BLOG, BLOG_FIELD_*, BLOG_FIELD_SEO_*, BLOG_URL_TEMPLATE=/articles/{slug}, BLOG_UPDATE, --update
  story→press_release: CS_CONTENT_TYPE_PRESS_RELEASE=press_release, PRESS_RELEASE_*, PRESS_RELEASE_START_SHEET, --update
`);
    process.exit(0);
  }

  if (cmd === "extract") await runExtractUrls(rest);
  else if (cmd === "extract-content-images") await runExtractContentImages(rest);
  else if (cmd === "extract-content-videos") await runExtractContentVideos(rest);
  else if (cmd === "migrate-media") await runMigrateMediaFromTracking(rest);
  else if (cmd === "migrate-content") await runMigrateContentFromTracking(rest);
  else if (cmd === "migrate-blog-authors") await runMigrateBlogAuthorsFromTracking(rest);
  else if (cmd === "migrate-blog-categories") await runMigrateBlogCategoriesFromTracking(rest);
  else if (cmd === "migrate-blog-stories") await runMigrateBlogStoriesFromTracking(rest);
  else if (cmd === "migrate-press-releases") await runMigratePressReleasesFromTracking(rest);
  else if (cmd === "publish") await runPublishFromTracking(rest);
  else if (cmd === "add-to-release") await runAddToReleaseFromTracking(rest);
  else if (cmd === "upload-folder-images") await runUploadFolderImages(rest);
  else if (cmd === "update-entry-urls") await runUpdateEntryUrls(rest);
  else if (cmd === "update-story-datelines") await runUpdateStoryDatelines(rest);
  else if (cmd === "update-bconnected-stories") await runUpdateBConnectedStories(rest);
  else throw new Error(`Unknown pipeline command: ${cmd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
