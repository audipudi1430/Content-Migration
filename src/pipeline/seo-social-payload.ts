import type { FileRefShape } from "./blog-author-config.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";

/** `seo.page_url` CMA shape for the SEO global field. */
export type SeoPageUrlShape = "string" | "modular" | "group" | "canonical_url_list";

/** Field UIDs inside the `seo` Global field (blog_author, blog_category). */
export type SeoSocialFieldUids = {
  /** Global field UID on the content type (e.g. `seo`). */
  seoSocialGroup: string;
  /** SEO title inside global (e.g. `title`, not `seo_title_tag`). */
  seoTitle: string;
  /** Page URL field (e.g. `page_url`). */
  seoPageUrl: string;
  /** `group` = `{ url, status }`; `modular` = `[{ url, status }]`; `canonical_url_list` = `{ canonical, url_list }`. */
  seoPageUrlShape: SeoPageUrlShape;
  seoPageUrlInnerUrl: string;
  seoPageUrlInnerStatus: string;
  seoPageUrlStatusDefault: string;
  /** Used when `seoPageUrlShape=canonical_url_list` (defaults match Broadcom stack). */
  seoPageUrlCanonicalField: string;
  seoPageUrlListField: string;
  seoPageUrlListItemUrl: string;
  seoPageUrlListItemStatus: string;
  seoPageUrlListItemRedirect: string;
  /** Optional; omit from payload when empty. */
  seoCanonical: string;
  /** Inner field UID for page owner inside the seo global (e.g. `page_owner`). */
  seoPageOwner: string;
  metaDescription: string;
  /** Group inside global holding the file reference (e.g. `meta_image`). */
  metaImageGroup: string;
  metaImageFileField: string;
  fileRefShape: FileRefShape;
};

export function parseSeoPageUrlShape(raw: string | undefined): SeoPageUrlShape | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "modular") return "modular";
  if (v === "string") return "string";
  if (v === "canonical_url_list" || v === "url_list" || v === "canonical") {
    return "canonical_url_list";
  }
  if (v === "group") return "group";
  return undefined;
}

/** Resolve page_url shape: type-specific env → `MIGRATION_SEO_PAGE_URL_SHAPE` → fallback. */
export function resolveSeoPageUrlShape(typeEnv: string | undefined, fallback: SeoPageUrlShape): SeoPageUrlShape {
  return (
    parseSeoPageUrlShape(typeEnv) ??
    parseSeoPageUrlShape(process.env.MIGRATION_SEO_PAGE_URL_SHAPE) ??
    fallback
  );
}

/** Value for `seo.page_owner` from env (`PAGE_OWNER`, `MIGRATION_PAGE_OWNER`, or legacy author default). */
export function loadMigrationPageOwnerValue(): string {
  return (
    process.env.PAGE_OWNER?.trim() ||
    process.env.page_owner?.trim() ||
    process.env.MIGRATION_PAGE_OWNER?.trim() ||
    process.env.BLOG_AUTHOR_PAGE_OWNER_DEFAULT?.trim() ||
    ""
  );
}

/** Shared inner field UIDs on the seo global (override via `MIGRATION_SEO_PAGE_OWNER_FIELD`). */
export function loadSharedSeoInnerFieldUids(): Pick<SeoSocialFieldUids, "seoPageOwner"> {
  return {
    seoPageOwner:
      process.env.MIGRATION_SEO_PAGE_OWNER_FIELD?.trim() ||
      process.env.BLOG_FIELD_SEO_PAGE_OWNER?.trim() ||
      "page_owner",
  };
}

/** Shared inner field UIDs for `seo.page_url` (override via `MIGRATION_SEO_PAGE_URL_*`). */
export function loadSharedSeoPageUrlFields(): Pick<
  SeoSocialFieldUids,
  | "seoPageUrlInnerUrl"
  | "seoPageUrlInnerStatus"
  | "seoPageUrlStatusDefault"
  | "seoPageUrlCanonicalField"
  | "seoPageUrlListField"
  | "seoPageUrlListItemUrl"
  | "seoPageUrlListItemStatus"
  | "seoPageUrlListItemRedirect"
> {
  return {
    seoPageUrlInnerUrl:
      process.env.MIGRATION_SEO_PAGE_URL_INNER_URL?.trim() ||
      process.env.BLOG_FIELD_SEO_PAGE_URL_URL?.trim() ||
      "url",
    seoPageUrlInnerStatus:
      process.env.MIGRATION_SEO_PAGE_URL_INNER_STATUS?.trim() ||
      process.env.BLOG_FIELD_SEO_PAGE_URL_STATUS?.trim() ||
      "status",
    seoPageUrlStatusDefault:
      process.env.MIGRATION_SEO_PAGE_URL_STATUS_DEFAULT?.trim() ||
      process.env.BLOG_SEO_PAGE_URL_STATUS_DEFAULT?.trim() ||
      "200",
    seoPageUrlCanonicalField:
      process.env.MIGRATION_SEO_PAGE_URL_CANONICAL_FIELD?.trim() || "canonical",
    seoPageUrlListField: process.env.MIGRATION_SEO_PAGE_URL_LIST_FIELD?.trim() || "url_list",
    seoPageUrlListItemUrl:
      process.env.MIGRATION_SEO_PAGE_URL_LIST_ITEM_URL?.trim() || "url",
    seoPageUrlListItemStatus:
      process.env.MIGRATION_SEO_PAGE_URL_LIST_ITEM_STATUS?.trim() || "status",
    seoPageUrlListItemRedirect:
      process.env.MIGRATION_SEO_PAGE_URL_LIST_ITEM_REDIRECT?.trim() || "redirect",
  };
}

function seoPageUrlStatusValue(defaultRaw: string): number | string {
  const n = Number(defaultRaw.trim());
  return Number.isFinite(n) ? Math.floor(n) : defaultRaw;
}

export type SeoLogContext = {
  wpId?: number;
  /** Log prefix entity, e.g. `blog-category`. */
  entity?: string;
};

function seoLogPrefix(ctx?: SeoLogContext): string {
  if (ctx?.wpId != null) return `[${ctx.entity ?? "seo"}] wp_id=${ctx.wpId}`;
  return `[${ctx?.entity ?? "seo"}]`;
}

export function warnIfSeoPageUrlMissing(
  seo: WpAuthorSeoData,
  fields: SeoSocialFieldUids,
  logContext?: SeoLogContext
): boolean {
  const path = seo.pageUrlPath?.trim();
  if (path) return true;
  console.error(
    `${seoLogPrefix(logContext)} WARNING: page_url (${fields.seoPageUrl}) is undefined/empty; ` +
      `omitting from seo global (no error thrown)`
  );
  return false;
}

export function setSeoMetaImageInGlobal(
  group: Record<string, unknown>,
  fields: Pick<SeoSocialFieldUids, "metaImageGroup" | "metaImageFileField" | "fileRefShape">,
  assetUid: string,
  mergeMetaImageGroup?: Record<string, unknown>
): void {
  group[fields.metaImageGroup] = {
    ...mergeMetaImageGroup,
    [fields.metaImageFileField]: contentstackFileRefValue(assetUid, fields.fileRefShape),
  };
}

/**
 * Populate the `seo` Global field: title, page_url, meta_description, meta_image.file.
 */
export function setSeoSocialGroup(
  entry: Record<string, unknown>,
  fields: SeoSocialFieldUids,
  seo: WpAuthorSeoData,
  metaDescription: string,
  mergeGroup?: Record<string, unknown>,
  metaImageAssetUid?: string,
  mergeMetaImageGroup?: Record<string, unknown>,
  logContext?: SeoLogContext
): void {
  const group: Record<string, unknown> = { ...mergeGroup };
  // Always replace page_url (do not merge/append url_list from existing entries on --update).
  delete group[fields.seoPageUrl];

  group[fields.metaDescription] = metaDescription;

  if (seo.seoTitleTag) {
    group[fields.seoTitle] = seo.seoTitleTag;
  }

  if (warnIfSeoPageUrlMissing(seo, fields, logContext)) {
    group[fields.seoPageUrl] = buildSeoPageUrlValue(fields, seo.pageUrlPath.trim());
  }

  if (fields.seoCanonical && seo.canonicalPath) {
    group[fields.seoCanonical] = seo.canonicalPath;
  }

  const pageOwnerValue = loadMigrationPageOwnerValue();
  if (pageOwnerValue && fields.seoPageOwner) {
    group[fields.seoPageOwner] = pageOwnerValue;
  }

  if (metaImageAssetUid) {
    setSeoMetaImageInGlobal(group, fields, metaImageAssetUid, mergeMetaImageGroup);
  }

  entry[fields.seoSocialGroup] = group;
}

/** CMA value for `seo.page_url` (group, modular, canonical+url_list, or plain string). */
export function buildSeoPageUrlValue(fields: SeoSocialFieldUids, path: string): unknown {
  if (fields.seoPageUrlShape === "canonical_url_list") {
    const status = seoPageUrlStatusValue(fields.seoPageUrlStatusDefault);
    return {
      [fields.seoPageUrlCanonicalField]: path,
      [fields.seoPageUrlListField]: [
        {
          [fields.seoPageUrlListItemRedirect]: "",
          [fields.seoPageUrlListItemStatus]: status,
          [fields.seoPageUrlListItemUrl]: path,
        },
      ],
    };
  }
  if (fields.seoPageUrlShape === "modular") {
    return [
      {
        [fields.seoPageUrlInnerUrl]: path,
        [fields.seoPageUrlInnerStatus]: fields.seoPageUrlStatusDefault,
      },
    ];
  }
  if (fields.seoPageUrlShape === "group") {
    return {
      [fields.seoPageUrlInnerUrl]: path,
      [fields.seoPageUrlInnerStatus]: fields.seoPageUrlStatusDefault,
    };
  }
  return path;
}

export function isSeoPageUrlValidationError(message: string): boolean {
  return /seo\.page_url|page_url.*not a valid object/i.test(message);
}

export function isTitleNotUniqueError(message: string): boolean {
  if (/title.*is not unique|is not unique.*title/i.test(message)) return true;
  const parsed = parseCmaEntryErrorJson(message);
  const titleErrors = parsed?.errors?.title;
  if (!titleErrors?.length) return false;
  return titleErrors.some((e) => /not unique/i.test(e));
}

export function isInvalidFileUploadError(message: string): boolean {
  return (
    /is not a valid upload|not a valid upload/i.test(message) ||
    /maximum size limit|is more than the maximum size/i.test(message)
  );
}

export type EntryFileImageFieldUids = {
  bannerImage?: string;
  bannerImageFileField?: string;
  thumbnail?: string;
  thumbnailImagePresetField?: string;
  thumbnailPresetImageField?: string;
  authorImage?: string;
  authorImageFileField?: string;
  seoSocialGroup?: string;
  metaImageGroup?: string;
  metaImageFileField?: string;
};

/** Parse CMA JSON body embedded in `Contentstack NNN POST entry: {...}` errors. */
export function parseCmaEntryErrorJson(message: string): { errors?: Record<string, string[]> } | undefined {
  const idx = message.indexOf("{");
  if (idx < 0) return undefined;
  try {
    return JSON.parse(message.slice(idx)) as { errors?: Record<string, string[]> };
  } catch {
    return undefined;
  }
}

/** Remove rejected file image refs so CMA retry can succeed. */
export function omitEntryFileImageFields(
  payload: Record<string, unknown>,
  fields: EntryFileImageFieldUids
): Record<string, unknown> {
  const copy = { ...payload };

  if (fields.authorImage && fields.authorImageFileField) {
    const author = copy[fields.authorImage];
    if (author && typeof author === "object" && !Array.isArray(author)) {
      const next = { ...(author as Record<string, unknown>) };
      delete next[fields.authorImageFileField];
      copy[fields.authorImage] = next;
    } else {
      delete copy[fields.authorImage];
    }
  }

  if (fields.bannerImage && fields.bannerImageFileField) {
    const banner = copy[fields.bannerImage];
    if (banner && typeof banner === "object" && !Array.isArray(banner)) {
      const next = { ...(banner as Record<string, unknown>) };
      delete next[fields.bannerImageFileField];
      copy[fields.bannerImage] = next;
    } else {
      delete copy[fields.bannerImage];
    }
  }

  if (
    fields.thumbnail &&
    fields.thumbnailImagePresetField &&
    fields.thumbnailPresetImageField
  ) {
    const thumb = copy[fields.thumbnail];
    if (thumb && typeof thumb === "object" && !Array.isArray(thumb)) {
      const nextThumb = { ...(thumb as Record<string, unknown>) };
      const preset = nextThumb[fields.thumbnailImagePresetField];
      if (preset && typeof preset === "object" && !Array.isArray(preset)) {
        const nextPreset = { ...(preset as Record<string, unknown>) };
        delete nextPreset[fields.thumbnailPresetImageField];
        delete nextPreset.uid;
        delete nextPreset.metadata;
        delete nextPreset.extension_uid;
        delete nextPreset._content_type_uid;
        nextThumb[fields.thumbnailImagePresetField] = nextPreset;
      } else {
        delete nextThumb[fields.thumbnailImagePresetField];
      }
      copy[fields.thumbnail] = nextThumb;
    } else {
      delete copy[fields.thumbnail];
    }
  }

  if (fields.seoSocialGroup && fields.metaImageGroup && fields.metaImageFileField) {
    const seo = copy[fields.seoSocialGroup];
    if (seo && typeof seo === "object" && !Array.isArray(seo)) {
      const group = { ...(seo as Record<string, unknown>) };
      const metaImage = group[fields.metaImageGroup];
      if (metaImage && typeof metaImage === "object" && !Array.isArray(metaImage)) {
        const nextMeta = { ...(metaImage as Record<string, unknown>) };
        delete nextMeta[fields.metaImageFileField];
        group[fields.metaImageGroup] = nextMeta;
      }
      copy[fields.seoSocialGroup] = group;
    }
  }

  return copy;
}

/** Remove `page_url` from the seo global so a retry can succeed. */
export function omitSeoPageUrlFromEntry(
  payload: Record<string, unknown>,
  fields: Pick<SeoSocialFieldUids, "seoSocialGroup" | "seoPageUrl">
): Record<string, unknown> {
  const copy = { ...payload };
  const seo = copy[fields.seoSocialGroup];
  if (seo && typeof seo === "object" && !Array.isArray(seo)) {
    const g = { ...(seo as Record<string, unknown>) };
    delete g[fields.seoPageUrl];
    copy[fields.seoSocialGroup] = g;
  }
  return copy;
}
