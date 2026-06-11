import type { FileRefShape } from "./blog-author-config.js";
import { contentstackFileRefValue } from "./blog-author-payload.js";
import type { WpAuthorSeoData } from "./blog-author-seo.js";

/** Field UIDs inside the `seo` Global field (blog_author, blog_category). */
export type SeoSocialFieldUids = {
  /** Global field UID on the content type (e.g. `seo`). */
  seoSocialGroup: string;
  /** SEO title inside global (e.g. `title`, not `seo_title_tag`). */
  seoTitle: string;
  /** Page URL field (e.g. `page_url`). */
  seoPageUrl: string;
  /** `group` = `{ url, status }`; `modular` = `[{ url, status }]`; `string` = path text. */
  seoPageUrlShape: "string" | "modular" | "group";
  seoPageUrlInnerUrl: string;
  seoPageUrlInnerStatus: string;
  seoPageUrlStatusDefault: string;
  /** Optional; omit from payload when empty. */
  seoCanonical: string;
  metaDescription: string;
  /** Group inside global holding the file reference (e.g. `meta_image`). */
  metaImageGroup: string;
  metaImageFileField: string;
  fileRefShape: FileRefShape;
};

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

  if (metaImageAssetUid) {
    setSeoMetaImageInGlobal(group, fields, metaImageAssetUid, mergeMetaImageGroup);
  }

  entry[fields.seoSocialGroup] = group;
}

/** CMA value for `seo.page_url` (group object vs modular block vs plain string). */
export function buildSeoPageUrlValue(fields: SeoSocialFieldUids, path: string): unknown {
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

export function isInvalidFileUploadError(message: string): boolean {
  return /is not a valid upload|not a valid upload/i.test(message);
}

export type EntryFileImageFieldUids = {
  bannerImage?: string;
  bannerImageFileField?: string;
  seoSocialGroup?: string;
  metaImageGroup?: string;
  metaImageFileField?: string;
};

/** Remove banner_image.file and seo.meta_image.file so CMA retry can succeed. */
export function omitEntryFileImageFields(
  payload: Record<string, unknown>,
  fields: EntryFileImageFieldUids
): Record<string, unknown> {
  const copy = { ...payload };

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
