import type { MigrationPhase } from "./types.js";
import { wpPostTypeToKind } from "../wordpress/client.js";

type WpContent = {
  id: number;
  slug: string;
  type: string;
  title: { rendered: string };
  content?: { rendered: string };
  categories?: number[];
};

/**
 * Migrate posts and pages after taxonomies and assets. Replace body HTML transformation
 * with your stack fields (modular blocks, RTE JSON, etc.).
 */
export const phasePostsAndPages: MigrationPhase = {
  name: "posts_and_pages",
  async run(ctx) {
    if (!ctx.uids.post || !ctx.uids.page) {
      console.error("Skipping posts/pages: set CS_CONTENT_TYPE_POST and CS_CONTENT_TYPE_PAGE");
      return;
    }
    const posts = await ctx.wp.collectAll<WpContent>("/wp-json/wp/v2/posts");
    const pages = await ctx.wp.collectAll<WpContent>("/wp-json/wp/v2/pages");

    for (const p of [...posts, ...pages]) {
      const kind = wpPostTypeToKind(p.type);
      if (ctx.map.has(kind, p.id, ctx.locale)) continue;

      const contentTypeUid = kind === "page" ? ctx.uids.page : ctx.uids.post;
      // const categoryRefs = (p.categories ?? []).map((id) =>
      //   requireMappedUid(ctx.map, "category", id, ctx.locale)
      // );

      const entry = await ctx.cs.createEntry(
        contentTypeUid,
        {
          title: p.title.rendered,
          url_slug: p.slug,
          body: p.content?.rendered ?? "",
          // categories: categoryRefs.map((uid) => ({ uid })),
        },
        ctx.locale
      );

      ctx.map.set({
        wpId: p.id,
        kind,
        contentstackUid: entry.uid,
        sourceKey: p.slug,
        migratedAt: new Date().toISOString(),
        locale: ctx.locale,
      });
    }
    await ctx.map.save();
  },
};
