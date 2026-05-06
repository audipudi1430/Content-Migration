import { initEnvFromArgs, loadAssetMigrationSettings, loadConfig } from "./config.js";
import { MappingStore } from "./mapping-store.js";
import { WordPressClient, basicAuthHeader } from "./wordpress/client.js";
import { ContentstackManagementClient } from "./contentstack/client.js";
import type { ContentModelUids } from "./phases/types.js";
import { phaseCategories } from "./phases/taxonomies.js";
import { phaseAssets } from "./phases/assets.js";
import { phasePostsAndPages } from "./phases/posts-and-pages.js";

function uidsFromEnv(): ContentModelUids {
  const category = process.env.CS_CONTENT_TYPE_CATEGORY;
  const tag = process.env.CS_CONTENT_TYPE_TAG;
  const post = process.env.CS_CONTENT_TYPE_POST;
  const page = process.env.CS_CONTENT_TYPE_PAGE;
  if (!category || !tag || !post || !page) {
    throw new Error(
      "Set CS_CONTENT_TYPE_CATEGORY, CS_CONTENT_TYPE_TAG, CS_CONTENT_TYPE_POST, CS_CONTENT_TYPE_PAGE (or run with --media-only)"
    );
  }
  return {
    category,
    tag,
    post,
    page,
    assetParentFolderUid: process.env.CS_ASSET_FOLDER_UID,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  initEnvFromArgs(argv);
  const mediaOnly = argv.includes("--media-only");

  const cfg = loadConfig();
  const auth =
    cfg.wp.user && cfg.wp.applicationPassword
      ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
      : undefined;
  const wp = new WordPressClient(cfg.wp.baseUrl, auth);
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });
  const map = await MappingStore.load(cfg.mappingFile);
  const uids: ContentModelUids = mediaOnly
    ? { assetParentFolderUid: process.env.CS_ASSET_FOLDER_UID }
    : uidsFromEnv();
  const locale = process.env.CONTENTSTACK_LOCALE;
  const assetMigration = loadAssetMigrationSettings();

  const phases = mediaOnly ? [phaseAssets] : [phaseCategories, phaseAssets, phasePostsAndPages];

  const ctx = { wp, cs, map, uids, locale, assetMigration };

  for (const phase of phases) {
    console.error(`Phase: ${phase.name}…`);
    await phase.run(ctx);
    console.error(`Phase: ${phase.name} done.`);
  }

  await map.save();
  console.error(`Mapping written to ${cfg.mappingFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
