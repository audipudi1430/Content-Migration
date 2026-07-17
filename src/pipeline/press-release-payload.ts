/**
 * Build Contentstack `press_release` entry payload from a WordPress story JSON object.
 */
import { pickRenderedTitle } from "./blog-author-seo.js";
import { setEntryReferences } from "./blog-payload.js";
import { normalizeWpText } from "./contentstack-rte.js";
import { resolveCmsAssetName } from "./cms-asset-name.js";
import { setSeoSocialGroup, type SeoLogContext } from "./seo-social-payload.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";
import {
  loadPressReleaseDefaultLocation,
  loadPressReleaseDefaultStatus,
  type PressReleaseFieldUids,
} from "./press-release-config.js";
import { buildPressReleaseBodyHtml } from "./press-release-body.js";
import { pickWpStoryDateline } from "./wp-dateline.js";

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Calendar date `YYYY-MM-DD` from WordPress `date` (Pacific wall calendar day). */
export function pressReleaseDateOnly(story: Record<string, unknown>): string {
  const date = pickString(story.date);
  const fromLocal = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  if (fromLocal?.[1]) return fromLocal[1];

  // Fallback: UTC dateline / date_gmt
  const dateline = pickWpStoryDateline(story);
  if (dateline) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(dateline);
    if (m?.[1]) return m[1];
  }
  const dateGmt = pickString(story.date_gmt);
  const fromGmt = /^(\d{4}-\d{2}-\d{2})/.exec(dateGmt);
  return fromGmt?.[1] ?? "";
}

export function pickPressReleaseSlug(story: Record<string, unknown>): string {
  return pickString(story.slug).replace(/^\/+|\/+$/g, "");
}

export type BuildPressReleasePayloadInput = {
  story: Record<string, unknown>;
  fields: PressReleaseFieldUids;
  pageUrl: string;
  cmsTitle: string;
  location?: string;
  articleCategoryUids?: string[];
  articleCategoryContentTypeUid: string;
  newsCategoryUids?: string[];
  newsCategoryContentTypeUid?: string;
  bodyHtml: string;
  locale?: string;
  microsite?: string;
};

export function buildPressReleaseEntryPayload(
  input: BuildPressReleasePayloadInput
): Record<string, unknown> & { title: string } {
  const {
    story,
    fields,
    pageUrl,
    cmsTitle,
    location,
    articleCategoryUids,
    articleCategoryContentTypeUid,
    newsCategoryUids,
    newsCategoryContentTypeUid,
    bodyHtml,
    locale,
    microsite,
  } = input;

  const displayTitle = normalizeWpText(cmsTitle) || pickRenderedTitle(story) || "Untitled";
  const entryTitle = resolveCmsAssetName(displayTitle, { locale, microsite });
  const dateOnly = pressReleaseDateOnly(story);
  const status = loadPressReleaseDefaultStatus();

  const entry: Record<string, unknown> & { title: string } = {
    title: entryTitle,
  };

  entry[fields.url] = pageUrl;
  entry[fields.newsTitle] = displayTitle;
  entry[fields.pageTitle] = "";
  entry[fields.subtitle] = "";
  entry[fields.description] = "";
  entry[fields.body] = bodyHtml;
  entry[fields.contacts] = [];
  entry[fields.location] = (location?.trim() || loadPressReleaseDefaultLocation()).trim();
  if (dateOnly) {
    entry[fields.releaseDate] = dateOnly;
    entry[fields.publishDate] = dateOnly;
  }
  entry[fields.status] = status;
  entry[fields.contentMetadata] = {
    end_date: null,
    internal_notes: "",
    publish_to_production: null,
    start_date: null,
  };

  if (articleCategoryUids?.length) {
    setEntryReferences(
      entry,
      fields.articleCategory,
      articleCategoryUids,
      articleCategoryContentTypeUid
    );
  } else {
    entry[fields.articleCategory] = [];
  }

  if (newsCategoryUids?.length && newsCategoryContentTypeUid) {
    // Schema is single reference (ref_multiple: false) — take first.
    const uid = newsCategoryUids[0]!;
    entry[fields.newsCategory] = [
      { uid, _content_type_uid: newsCategoryContentTypeUid },
    ];
  } else {
    entry[fields.newsCategory] = [];
  }

  return entry;
}

export function setPressReleaseSeoGlobal(
  entry: Record<string, unknown>,
  fields: PressReleaseFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGlobal?: Record<string, unknown>,
  logContext?: SeoLogContext
): void {
  setSeoSocialGroup(
    entry,
    fields,
    seo,
    metaDescription,
    mergeGlobal,
    undefined,
    undefined,
    logContext
  );
}

/** Build body HTML helper re-export for callers. */
export { buildPressReleaseBodyHtml };
