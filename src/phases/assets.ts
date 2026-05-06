import type { MigrationPhase } from "./types.js";

type WpMedia = {
  id: number;
  source_url: string;
  slug: string;
  mime_type: string;
  title?: { rendered?: string };
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim() || s;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "application/pdf": ".pdf",
};

function mimeToExt(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? "";
}

function filenameForUpload(m: WpMedia): string {
  try {
    const seg = new URL(m.source_url).pathname.split("/").filter(Boolean).pop();
    if (seg && seg.includes(".")) return decodeURIComponent(seg);
  } catch {
    /* ignore */
  }
  const ext = mimeToExt(m.mime_type) || ".bin";
  const base = (m.slug || `wp-media-${m.id}`).replace(/[/\\?%*:|"<>]/g, "-");
  return `${base}${ext}`;
}

/**
 * Migrate WordPress media to Contentstack assets in a dedicated folder.
 * Uses `migration-map.json` state.wpMediaListOffset to resume; set MEDIA_BATCH_SIZE per run.
 */
export const phaseAssets: MigrationPhase = {
  name: "assets",
  async run(ctx) {
    const settings = ctx.assetMigration;
    if (!settings) {
      throw new Error("assetMigration settings missing (loadAssetMigrationSettings in migrate.ts)");
    }

    const batchSize = settings.batchSize;
    let offset = settings.offsetOverride ?? ctx.map.getMediaListOffset();

    let folderUid = ctx.uids.assetParentFolderUid;
    if (!folderUid) {
      folderUid = ctx.map.getWpMediaAssetFolderUid();
    }
    if (!folderUid) {
      const created = await ctx.cs.createAssetFolder(
        settings.folderName,
        settings.parentFolderUid
      );
      folderUid = created.uid;
      ctx.map.setWpMediaAssetFolderUid(folderUid);
      await ctx.map.save();
      console.error(`Created Contentstack asset folder "${settings.folderName}" uid=${folderUid}`);
    }

    let uploadedThisRun = 0;
    const perPage = "100";

    batching: while (uploadedThisRun < batchSize) {
      const { items } = await ctx.wp.getCollectionPage<WpMedia>("/wp-json/wp/v2/media", {
        orderby: "id",
        order: "asc",
        per_page: perPage,
        offset: String(offset),
      });

      if (items.length === 0) {
        console.error(`No WordPress media left (offset ${offset}).`);
        break;
      }

      for (const m of items) {
        if (uploadedThisRun >= batchSize) break batching;

        try {
          if (!ctx.map.has("asset", m.id, ctx.locale)) {
            const filename = filenameForUpload(m);
            const title =
              m.title?.rendered != null
                ? stripHtml(m.title.rendered).slice(0, 250) || filename
                : filename;

            const { buffer, contentType } = await ctx.wp.fetchBinary(m.source_url);
            const { uid } = await ctx.cs.uploadAssetFile({
              buffer,
              filename,
              contentType: m.mime_type || contentType,
              title,
              parentFolderUid: folderUid,
            });

            ctx.map.set({
              wpId: m.id,
              kind: "asset",
              assetUid: uid,
              sourceKey: m.slug,
              migratedAt: new Date().toISOString(),
              locale: ctx.locale,
            });
            uploadedThisRun += 1;
            console.error(`Asset wp id=${m.id} → Contentstack uid=${uid} (${uploadedThisRun}/${batchSize} this run)`);
          }
        } finally {
          offset += 1;
          ctx.map.setMediaListOffset(offset);
        }
      }

      await ctx.map.save();
    }

    await ctx.map.save();
    console.error(
      `Assets phase: ${uploadedThisRun} uploaded this run; next WP media list offset = ${ctx.map.getMediaListOffset()}`
    );
  },
};
