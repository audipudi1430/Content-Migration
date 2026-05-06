import type { MigrationPhase } from "./types.js";

/**
 * Migrate categories (and similarly tags) before posts/pages so reference fields resolve.
 * Wire to your WP `/wp/v2/categories` and Contentstack category content type.
 */
export const phaseCategories: MigrationPhase = {
  name: "categories",
  async run(ctx) {
    if (!ctx.uids.category) {
      console.error("Skipping categories: set CS_CONTENT_TYPE_CATEGORY");
      return;
    }
    type WpCat = { id: number; name: string; slug: string; parent: number; description?: string };
    const cats = await ctx.wp.collectAll<WpCat>("/wp-json/wp/v2/categories");
    for (const c of cats) {
      if (ctx.map.has("category", c.id, ctx.locale)) continue;
      const entry = await ctx.cs.createEntry(
        ctx.uids.category,
        {
          title: c.name,
          url_slug: c.slug,
          description: c.description ?? "",
          // parent_category: resolve via ctx.map after parent is migrated (re-sort or second pass)
        },
        ctx.locale
      );
      ctx.map.set({
        wpId: c.id,
        kind: "category",
        contentstackUid: entry.uid,
        sourceKey: c.slug,
        migratedAt: new Date().toISOString(),
        locale: ctx.locale,
      });
    }
    await ctx.map.save();
  },
};
