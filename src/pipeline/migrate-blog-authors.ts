import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ensureAssetFolderUid } from "../media/migrate-media-core.js";
import { ensureWpAttachmentImageAssetUid } from "./wp-media-asset.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, type SelectionMode } from "./args.js";
import {
  blogAuthorPageUrlPath,
  loadBlogAuthorContentTypeUid,
  loadBlogAuthorFieldUids,
} from "./blog-author-config.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { buildContentstackEntryTargetUrl } from "./cs-target-url.js";

type WpStoryAuthor = {
  id: number;
  name: string;
  slug: string;
  description?: string;
  link?: string;
  meta?: Record<string, unknown>;
  yoast_head_json?: {
    title?: string;
    description?: string;
    og_image?: { url?: string }[];
  };
};

function pickPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function setScalar(entry: Record<string, unknown>, fieldUid: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  entry[fieldUid] = value;
}

/** Contentstack single-file field: one-element array of `{ uid: assetUid }`. */
function setAssetRef(entry: Record<string, unknown>, fieldUid: string, assetUid: string): void {
  entry[fieldUid] = [{ uid: assetUid }];
}

function seoTitle(term: WpStoryAuthor): string {
  const m = term.meta ?? {};
  const fromMeta = pickString(m.seo_title ?? m._yoast_wpseo_title);
  if (fromMeta) return fromMeta;
  return pickString(term.yoast_head_json?.title);
}

function seoDescription(term: WpStoryAuthor): string {
  const m = term.meta ?? {};
  const fromMeta = pickString(m.meta_description ?? m._yoast_wpseo_metadesc);
  if (fromMeta) return fromMeta;
  return pickString(term.yoast_head_json?.description);
}

export async function runMigrateBlogAuthorsFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "BLOG_AUTHOR_TRACK");
  const paths = loadPipelinePaths();
  const contentTypeUid = loadBlogAuthorContentTypeUid();
  if (!contentTypeUid) {
    throw new Error("Set MIGRATION_CONTENT_TYPE_UID=blog_author or CS_CONTENT_TYPE_BLOG_AUTHOR=blog_author");
  }
  const fields = loadBlogAuthorFieldUids();
  const cfg = loadConfig();
  const mongoCfg = loadMongoConfig();
  const mediaSheetPath = process.env.MEDIA_SHEET_PATH ?? "wp-media-mapping.xlsx";
  const pageOwnerDefault = process.env.BLOG_AUTHOR_PAGE_OWNER_DEFAULT?.trim() ?? "";

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
  const locale = process.env.CONTENTSTACK_LOCALE;
  const folderUid = await ensureAssetFolderUid(map, cs);

  const restSeg = paths.wpRestPath.replace(/\/$/, "").split("/").pop() ?? "";
  if (restSeg !== "story_author") {
    console.error(
      `[migrate-blog-authors] Warning: MIGRATION_WP_REST_PATH last segment is "${restSeg}", expected story_author. Proceeding anyway.`
    );
  }

  const allTracking = loadAllTracking(paths);
  const selected = selectContentRows(allTracking, paths.migrateStartSheet, sel.mode as SelectionMode, sel);

  if (selected.length === 0) {
    console.error("No story_author tracking rows selected for this sheet.");
    await closeMongo();
    return;
  }

  let ok = 0;
  for (const tRow of selected) {
    const trackRef = allTracking.find(
      (r) =>
        r.row_kind === "content" &&
        r.source_sheet === tRow.source_sheet &&
        r.wp_id === tRow.wp_id &&
        r.url === tRow.url
    );
    if (!trackRef) continue;
    try {
      const existing = map.get("story_author", tRow.wp_id, locale);
      if (existing?.contentstackUid) {
        trackRef.contentstack_entry_uid = existing.contentstackUid;
        trackRef.migration_status = "Pass";
        trackRef.migration_message = "Already in JSON map";
        trackRef.updated_at = new Date().toISOString();
        trackRef.target_url = buildContentstackEntryTargetUrl({
          apiHost: cfg.contentstack.apiHost,
          stackApiKey: cfg.contentstack.stackApiKey,
          contentTypeUid,
          entryUid: existing.contentstackUid,
          locale,
        });
        await persistOneRow(paths, allTracking, trackRef, mongoCfg);
        ok += 1;
        continue;
      }

      const restBase = (trackRef.wp_rest_path || paths.wpRestPath).replace(/\/$/, "");
      const rel = `${restBase.replace(/^\//, "")}/${tRow.wp_id}`;
      const term = await wp.getJson<WpStoryAuthor>(rel);
      const name = pickString(term.name) || `Author ${term.id}`;
      const slug = pickString(term.slug) || String(term.id);
      const authorUrlPath = blogAuthorPageUrlPath(slug);
      const meta = term.meta ?? {};

      const avatarId = pickPositiveInt(meta.avatar_image_id);
      const metaImageId = pickPositiveInt(meta.downloadable_image_id);

      const entryPayload: Record<string, unknown> = {
        title: name,
      };

      setScalar(entryPayload, fields.cmsAssetName, name);
      setScalar(entryPayload, fields.url, authorUrlPath);
      setScalar(entryPayload, fields.authorTitle, name);
      setScalar(entryPayload, fields.authorName, name);
      setScalar(entryPayload, fields.description, pickString(term.description));
      setScalar(entryPayload, fields.twitterLink, pickString(meta.twitter_url));
      setScalar(entryPayload, fields.linkedinLink, pickString(meta.linkedin_url));
      setScalar(entryPayload, fields.facebookLink, pickString(meta.facebook_url));
      setScalar(entryPayload, fields.seoTitleTag, seoTitle(term));
      setScalar(entryPayload, fields.metaDescription, seoDescription(term));
      setScalar(entryPayload, fields.pageOwner, pageOwnerDefault);

      if (avatarId) {
        const uid = await ensureWpAttachmentImageAssetUid(
          avatarId,
          wp,
          cs,
          map,
          mediaSheetPath,
          folderUid,
          locale,
          `Author ${term.id} avatar`
        );
        setAssetRef(entryPayload, fields.authorImage, uid);
        trackRef.featured_media_wp_id = String(avatarId);
      }

      if (metaImageId) {
        const uid = await ensureWpAttachmentImageAssetUid(
          metaImageId,
          wp,
          cs,
          map,
          mediaSheetPath,
          folderUid,
          locale,
          `Author ${term.id} meta image`
        );
        setAssetRef(entryPayload, fields.metaImage, uid);
      }

      const entry = await cs.createEntry(contentTypeUid, entryPayload as { title: string }, locale);
      map.set({
        wpId: tRow.wp_id,
        kind: "story_author",
        contentstackUid: entry.uid,
        sourceKey: slug,
        migratedAt: new Date().toISOString(),
        locale,
      });
      await map.save();

      trackRef.contentstack_entry_uid = entry.uid;
      trackRef.content_type_uid = contentTypeUid;
      trackRef.migration_status = "Pass";
      trackRef.migration_message = "";
      trackRef.updated_at = new Date().toISOString();
      trackRef.target_url = buildContentstackEntryTargetUrl({
        apiHost: cfg.contentstack.apiHost,
        stackApiKey: cfg.contentstack.stackApiKey,
        contentTypeUid,
        entryUid: entry.uid,
        locale,
      });
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      trackRef.migration_status = "Fail";
      trackRef.migration_message = msg;
      trackRef.target_url = "";
      trackRef.updated_at = new Date().toISOString();
      await persistOneRow(paths, allTracking, trackRef, mongoCfg);
      console.error(`[blog-author] wp_id=${tRow.wp_id} FAIL: ${msg}`);
    }
  }

  await closeMongo();
  console.error(`[migrate-blog-authors] Finished. ${ok}/${selected.length} OK for sheet "${paths.migrateStartSheet}".`);
}
