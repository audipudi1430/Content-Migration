import type { BlogFieldUids, BlogReferenceShape } from "./blog-config.js";

/** CMA reference value for a single linked entry. */
export function contentstackEntryRefValue(
  uid: string,
  contentTypeUid: string,
  shape: BlogReferenceShape = "object"
): unknown {
  const ref = { uid, _content_type_uid: contentTypeUid };
  return shape === "array" ? [ref] : ref;
}

export function setEntryReference(
  entry: Record<string, unknown>,
  fieldUid: string,
  uid: string,
  contentTypeUid: string,
  shape: BlogReferenceShape = "object"
): void {
  if (!fieldUid || !uid || !contentTypeUid) return;
  entry[fieldUid] = contentstackEntryRefValue(uid, contentTypeUid, shape);
}

export function setScalar(entry: Record<string, unknown>, fieldUid: string, value: unknown): void {
  if (!fieldUid) return;
  if (value === undefined || value === null) return;
  if (typeof value === "string" && value.trim() === "") return;
  entry[fieldUid] = value;
}

/** Extract positive integer term IDs from WP REST taxonomy values (ids, objects, or strings). */
export function pickWpTermIds(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  const toId = (item: unknown): number | undefined => {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) return Math.floor(item);
    if (typeof item === "string") {
      const n = Number(item.trim());
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return undefined;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as { id?: unknown; term_id?: unknown }).id ?? (item as { term_id?: unknown }).term_id;
      if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.floor(id);
      if (typeof id === "string") {
        const n = Number(id.trim());
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    }
    return undefined;
  };

  if (Array.isArray(value)) {
    return value.map(toId).filter((n): n is number => n !== undefined);
  }
  const single = toId(value);
  return single !== undefined ? [single] : [];
}

export function pickRenderedTitle(title: unknown): string {
  if (title && typeof title === "object" && "rendered" in title) {
    const rendered = (title as { rendered?: unknown }).rendered;
    if (typeof rendered === "string") return rendered.trim();
  }
  if (typeof title === "string") return title.trim();
  return "";
}

export function pickMetaString(meta: Record<string, unknown> | undefined, key: string): string {
  if (!key || !meta) return "";
  const v = meta[key];
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  return "";
}

export type BuildBlogPayloadInput = {
  story: Record<string, unknown>;
  fields: BlogFieldUids;
  pageUrl: string;
  cmsTitle: string;
  categoryRefUid?: string;
  categoryRefContentTypeUid: string;
  authorRefUid?: string;
  authorRefContentTypeUid: string;
  seriesRefUid?: string;
  seriesRefContentTypeUid?: string;
  selectDefaults: { showInNewsroomLanding?: string; showInLatestBlogs?: string };
  metaKeys: {
    subHeader: string;
    shortLinkText: string;
    byline: string;
    blogTopics: string;
  };
};

export function buildBlogEntryPayload(input: BuildBlogPayloadInput): Record<string, unknown> {
  const {
    story,
    fields,
    pageUrl,
    cmsTitle,
    categoryRefUid,
    categoryRefContentTypeUid,
    authorRefUid,
    authorRefContentTypeUid,
    seriesRefUid,
    seriesRefContentTypeUid,
    selectDefaults,
    metaKeys,
  } = input;

  const meta =
    story.meta && typeof story.meta === "object" && !Array.isArray(story.meta)
      ? (story.meta as Record<string, unknown>)
      : undefined;

  const entry: Record<string, unknown> = {
    title: cmsTitle,
  };

  setScalar(entry, fields.cmsAssetName, cmsTitle);
  setScalar(entry, fields.url, pageUrl);
  setScalar(entry, fields.headline, cmsTitle);
  setScalar(entry, fields.subHeader, pickMetaString(meta, metaKeys.subHeader));
  setScalar(entry, fields.shortLinkText, pickMetaString(meta, metaKeys.shortLinkText));
  setScalar(entry, fields.byline, pickMetaString(meta, metaKeys.byline));
  setScalar(entry, fields.blogTopics, pickMetaString(meta, metaKeys.blogTopics));
  setScalar(entry, fields.showInNewsroomLanding, selectDefaults.showInNewsroomLanding);
  setScalar(entry, fields.showInLatestBlogs, selectDefaults.showInLatestBlogs);

  if (categoryRefUid) {
    setEntryReference(
      entry,
      fields.blogCategory,
      categoryRefUid,
      categoryRefContentTypeUid,
      fields.referenceShape
    );
  }

  if (authorRefUid) {
    setEntryReference(
      entry,
      fields.blogAuthorProfile,
      authorRefUid,
      authorRefContentTypeUid,
      fields.referenceShape
    );
  }

  if (seriesRefUid && seriesRefContentTypeUid) {
    setEntryReference(
      entry,
      fields.seriesLabel,
      seriesRefUid,
      seriesRefContentTypeUid,
      fields.referenceShape
    );
  }

  return entry;
}
