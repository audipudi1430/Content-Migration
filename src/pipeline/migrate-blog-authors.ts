import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { loadConfig } from "../config.js";
import { loadMongoConfig, loadPipelinePaths } from "../config-pipeline.js";
import { ensureAssetFolderUid } from "../media/migrate-media-core.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, parseSelection, parseUpdateFlag, type SelectionMode } from "./args.js";
import {
  blogAuthorPageUrlPath,
  loadBlogAuthorContentTypeUid,
  loadBlogAuthorFieldUids,
  type BlogAuthorFieldUids,
} from "./blog-author-config.js";
import { extractWpAuthorSeo, resolveSeoMetaDescription, type WpAuthorSeoSource } from "./blog-author-seo.js";
import { loadAllTracking, persistOneRow } from "./tracking-sync.js";
import { selectContentRows } from "./migrate-from-tracking.js";
import { buildContentstackEntryTargetUrl } from "./cs-target-url.js";
import {
  loadBlogAuthorDescriptionFormat,
  setAuthorDescription,
  setAuthorImageField,
  setFileAssetRef,
} from "./blog-author-payload.js";
import { setSeoSocialGroup } from "./seo-social-payload.js";
import { resolveWpImageAssetUid } from "./resolve-wp-image-asset.js";
import type { PipelinePathsConfig } from "../config-pipeline.js";
import type { TrackingRow } from "./types.js";

type WpStoryAuthor = WpAuthorSeoSource & {
  description?: string | { rendered?: string };
  yoast_head_json?: WpAuthorSeoSource["yoast_head_json"] & {
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
  if (!fieldUid) return;
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  entry[fieldUid] = value;
}

type BuildAuthorPayloadCtx = {
  term: WpStoryAuthor;
  fields: BlogAuthorFieldUids;
  pageOwnerDefault: string;
  wp: WordPressClient;
  cs: ContentstackManagementClient;
  map: MappingStore;
  mediaSheetPath: string;
  folderUid: string;
  locale: string | undefined;
  paths: PipelinePathsConfig;
  allTracking: TrackingRow[];
  trackRef: TrackingRow;
  /** Existing entry (for --update): preserve other sub-fields in groups like author_image. */
  existingEntry?: Record<string, unknown>;
};

async function buildBlogAuthorEntryPayload(ctx: BuildAuthorPayloadCtx): Promise<{
  payload: Record<string, unknown>;
  slug: string;
}> {
  const { term, fields, trackRef } = ctx;
  const name = pickString(term.name) || `Author ${term.id}`;
  const slug = pickString(term.slug) || String(term.id);
  const fallbackUrlPath = blogAuthorPageUrlPath(slug);
  const seo = extractWpAuthorSeo(term, fallbackUrlPath);
  const meta = term.meta ?? {};

  const avatarId = pickPositiveInt(meta.avatar_image_id);
  const metaImageId = pickPositiveInt(meta.downloadable_image_id);

  const entryPayload: Record<string, unknown> = {
    title: name,
  };

  const authorTitle = pickString(meta.position);
  setScalar(entryPayload, fields.cmsAssetName, name);
  setScalar(entryPayload, fields.url, seo.pageUrlPath);
  setScalar(entryPayload, fields.authorTitle, authorTitle);
  setScalar(entryPayload, fields.authorName, name);

  const descFormat = loadBlogAuthorDescriptionFormat();
  const descLog = setAuthorDescription(entryPayload, fields.description, term.description, descFormat);
  console.error(
    `[blog-author] wp_id=${term.id} description field=${descLog.fieldUid} format=${descLog.format} ` +
      `wp_len=${descLog.wpRawLength} set=${descLog.set} payloadType=${descLog.payloadType ?? "—"}`
  );
  if (descLog.wpPreview) {
    console.error(`[blog-author] wp_id=${term.id} description WP preview: ${descLog.wpPreview}`);
  }
  if (descLog.payloadPreview) {
    console.error(`[blog-author] wp_id=${term.id} description CS payload preview: ${descLog.payloadPreview}`);
  }

  setScalar(entryPayload, fields.twitterLink, pickString(meta.twitter_url));
  setScalar(entryPayload, fields.linkedinLink, pickString(meta.linkedin_url));
  setScalar(entryPayload, fields.facebookLink, pickString(meta.facebook_url));
  setScalar(entryPayload, fields.pageOwner, ctx.pageOwnerDefault);

  const existingSeoSocial =
    ctx.existingEntry?.[fields.seoSocialGroup] &&
    typeof ctx.existingEntry[fields.seoSocialGroup] === "object" &&
    !Array.isArray(ctx.existingEntry[fields.seoSocialGroup])
      ? (ctx.existingEntry[fields.seoSocialGroup] as Record<string, unknown>)
      : undefined;
  const metaDescription = resolveSeoMetaDescription(name, seo, "name");
  setSeoSocialGroup(entryPayload, fields, seo, metaDescription, existingSeoSocial);
  console.error(
    `[blog-author] wp_id=${term.id} author_title<=meta.position="${authorTitle || "(empty)"}" author_name="${name}"`
  );
  console.error(
    `[blog-author] wp_id=${term.id} seo group=${fields.seoSocialGroup} ` +
      `seoTitleTag=${seo.seoTitleTag} pageUrl=${seo.pageUrlPath} canonical=${seo.canonicalPath} metaDesc="${metaDescription}"`
  );
  console.error(
    `[blog-author] wp_id=${term.id} seo payload: ${JSON.stringify(entryPayload[fields.seoSocialGroup])}`
  );

  if (avatarId) {
    const { assetUid, source } = await resolveWpImageAssetUid({
      attachmentId: avatarId,
      wp: ctx.wp,
      cs: ctx.cs,
      map: ctx.map,
      mediaSheetPath: ctx.mediaSheetPath,
      folderUid: ctx.folderUid,
      locale: ctx.locale,
      purpose: `Author ${term.id} avatar (meta.avatar_image_id)`,
      paths: ctx.paths,
      allTracking: ctx.allTracking,
    });
    const existingAuthorImage =
      ctx.existingEntry?.[fields.authorImage] &&
      typeof ctx.existingEntry[fields.authorImage] === "object" &&
      !Array.isArray(ctx.existingEntry[fields.authorImage])
        ? (ctx.existingEntry[fields.authorImage] as Record<string, unknown>)
        : undefined;
    setAuthorImageField(entryPayload, fields, assetUid, existingAuthorImage);
    trackRef.featured_media_wp_id = String(avatarId);
    trackRef.contentstack_asset_uid = assetUid;
    console.error(
      `[blog-author] wp_id=${term.id} author_image group=${fields.authorImage} layout=${fields.authorImageLayout} ` +
        `fileField=${fields.authorImageFileField} assetUid=${assetUid} source=${source} ` +
        `payload=${JSON.stringify(entryPayload[fields.authorImage])}`
    );
  }

  if (metaImageId) {
    const { assetUid, source } = await resolveWpImageAssetUid({
      attachmentId: metaImageId,
      wp: ctx.wp,
      cs: ctx.cs,
      map: ctx.map,
      mediaSheetPath: ctx.mediaSheetPath,
      folderUid: ctx.folderUid,
      locale: ctx.locale,
      purpose: `Author ${term.id} meta image (meta.downloadable_image_id)`,
      paths: ctx.paths,
      allTracking: ctx.allTracking,
    });
    setFileAssetRef(entryPayload, fields.metaImage, assetUid, fields.fileRefShape);
    console.error(`[blog-author] wp_id=${term.id} meta_image asset=${assetUid} source=${source}`);
  }

  return { payload: entryPayload, slug };
}

function resolveExistingEntryUid(
  mapRecord: { contentstackUid?: string } | undefined,
  trackRef: TrackingRow
): string | undefined {
  return mapRecord?.contentstackUid?.trim() || trackRef.contentstack_entry_uid?.trim() || undefined;
}

export async function runMigrateBlogAuthorsFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const sel = parseSelection(argv, "BLOG_AUTHOR_TRACK");
  const updateExisting = parseUpdateFlag(argv, "BLOG_AUTHOR_UPDATE");
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

  if (updateExisting) {
    console.error("[migrate-blog-authors] --update: will PUT existing Contentstack entries when UID is known.");
  }

  const allTracking = loadAllTracking(paths);
  const selected = selectContentRows(
    allTracking,
    paths.migrateStartSheet,
    sel.mode as SelectionMode,
    sel,
    updateExisting
  );

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
      const mapRecord = map.get("story_author", tRow.wp_id, locale);
      const existingUid = resolveExistingEntryUid(mapRecord, trackRef);

      if (!updateExisting && existingUid) {
        trackRef.contentstack_entry_uid = existingUid;
        trackRef.migration_status = "Pass";
        trackRef.migration_message = "Already in JSON map (use --update to refresh from WordPress)";
        trackRef.updated_at = new Date().toISOString();
        trackRef.target_url = buildContentstackEntryTargetUrl({
          apiHost: cfg.contentstack.apiHost,
          stackApiKey: cfg.contentstack.stackApiKey,
          contentTypeUid,
          entryUid: existingUid,
          locale,
        });
        await persistOneRow(paths, allTracking, trackRef, mongoCfg);
        ok += 1;
        continue;
      }

      const restBase = (trackRef.wp_rest_path || paths.wpRestPath).replace(/\/$/, "");
      const rel = `${restBase.replace(/^\//, "")}/${tRow.wp_id}`;
      const term = await wp.getJson<WpStoryAuthor>(rel);

      let existingEntry: Record<string, unknown> | undefined;
      if (existingUid) {
        try {
          existingEntry = (await cs.getEntry(contentTypeUid, existingUid, locale)) as Record<string, unknown>;
        } catch {
          existingEntry = undefined;
        }
      }

      const { payload: entryPayload, slug } = await buildBlogAuthorEntryPayload({
        term,
        fields,
        pageOwnerDefault,
        wp,
        cs,
        map,
        mediaSheetPath,
        folderUid,
        locale,
        paths,
        allTracking,
        trackRef,
        existingEntry,
      });

      let entryUid: string;

      if (updateExisting && existingUid) {
        const updated = await cs.updateEntry(
          contentTypeUid,
          existingUid,
          entryPayload as { title: string },
          locale
        );
        entryUid = updated.uid ?? existingUid;
        trackRef.migration_message = "Updated from WordPress (--update)";
        console.error(`[blog-author] wp_id=${tRow.wp_id} UPDATED entry ${entryUid}`);
      } else if (updateExisting && !existingUid) {
        throw new Error(
          "No Contentstack entry UID in map or tracking; run migrate without --update first, or set contentstack_entry_uid on the row"
        );
      } else {
        const entry = await cs.createEntry(contentTypeUid, entryPayload as { title: string }, locale);
        entryUid = entry.uid;
        trackRef.migration_message = "";
        console.error(`[blog-author] wp_id=${tRow.wp_id} CREATED entry ${entryUid}`);
      }

      map.set({
        wpId: tRow.wp_id,
        kind: "story_author",
        contentstackUid: entryUid,
        sourceKey: slug,
        migratedAt: new Date().toISOString(),
        locale,
      });
      await map.save();

      trackRef.contentstack_entry_uid = entryUid;
      trackRef.content_type_uid = contentTypeUid;
      trackRef.migration_status = "Pass";
      trackRef.updated_at = new Date().toISOString();
      trackRef.target_url = buildContentstackEntryTargetUrl({
        apiHost: cfg.contentstack.apiHost,
        stackApiKey: cfg.contentstack.stackApiKey,
        contentTypeUid,
        entryUid,
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
