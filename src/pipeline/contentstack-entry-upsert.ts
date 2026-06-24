import type { ContentstackManagementClient } from "../contentstack/client.js";
import { formatFileSizeBytes } from "./image-size-limit.js";
import {
  isInvalidFileUploadError,
  isSeoPageUrlValidationError,
  isTitleNotUniqueError,
  omitAllEntryImageFields,
  omitEntryImageFieldsForErrorPaths,
  omitSeoPageUrlFromEntry,
  parseCmaEntryErrorJson,
  type EntryFileImageFieldUids,
  type SeoLogContext,
  type SeoSocialFieldUids,
} from "./seo-social-payload.js";

function seoLogPrefix(ctx?: SeoLogContext): string {
  if (ctx?.wpId != null) return `[${ctx.entity ?? "seo"}] wp_id=${ctx.wpId}`;
  return `[${ctx?.entity ?? "seo"}]`;
}

function parseSizeLimitFromErrorDetail(detail: string): string | undefined {
  const m = detail.match(/maximum size limit of\s+([^.]+)/i);
  return m?.[1]?.trim();
}

async function buildImageOmitWarnings(
  msg: string,
  omittedPaths: string[],
  payload: Record<string, unknown>,
  fields: EntryFileImageFieldUids,
  cs: ContentstackManagementClient
): Promise<string> {
  const parsed = parseCmaEntryErrorJson(msg);
  const parts: string[] = [];

  for (const path of omittedPaths) {
    const detail = parsed?.errors?.[path]?.[0];
    const limit = detail ? parseSizeLimitFromErrorDetail(detail) : undefined;
    let sizePart = "";
    const assetUid = resolveAssetUidForOmitWarning(payload, fields, path);
    if (assetUid) {
      const bytes = await cs.getAssetFileSizeBytes(assetUid);
      if (bytes) sizePart = `actual file size ${formatFileSizeBytes(bytes)}`;
    }
    const limitPart = limit ? `limit ${limit}` : "";
    const meta = [sizePart, limitPart].filter(Boolean).join("; ");
    parts.push(
      `${path} omitted after CMA validation error` + (meta ? ` (${meta})` : "")
    );
  }

  if (parts.length === 0) {
    return `image fields omitted after CMA validation error: ${msg.slice(0, 160)}`;
  }
  return parts.join("; ");
}

function resolveAssetUidForOmitWarning(
  payload: Record<string, unknown>,
  fields: EntryFileImageFieldUids,
  errorPath: string
): string | undefined {
  const norm = errorPath.toLowerCase();

  if (fields.authorImage) {
    const authorPath = `${fields.authorImage}.${fields.authorImageFileField ?? "file"}`.toLowerCase();
    if (norm === authorPath || norm.startsWith(`${fields.authorImage.toLowerCase()}.`)) {
      return pickFileRefUidFromPayload(payload, fields.authorImage, fields.authorImageFileField);
    }
  }
  if (fields.categoryThumbnail && fields.categoryThumbnailFileField) {
    const catPath =
      `${fields.categoryThumbnail}.${fields.categoryThumbnailFileField}`.toLowerCase();
    if (norm === catPath || norm.startsWith(`${fields.categoryThumbnail.toLowerCase()}.`)) {
      return pickFileRefUidFromPayload(
        payload,
        fields.categoryThumbnail,
        fields.categoryThumbnailFileField
      );
    }
  }
  if (fields.bannerImage) {
    const bannerPath = `${fields.bannerImage}.${fields.bannerImageFileField ?? "file"}`.toLowerCase();
    if (norm === bannerPath || norm.startsWith(`${fields.bannerImage.toLowerCase()}.`)) {
      return pickFileRefUidFromPayload(payload, fields.bannerImage, fields.bannerImageFileField);
    }
  }
  if (fields.thumbnail && fields.thumbnailImagePresetField) {
    const thumbPrefix = `${fields.thumbnail}.${fields.thumbnailImagePresetField}`.toLowerCase();
    if (norm === thumbPrefix || norm.startsWith(`${thumbPrefix}.`)) {
      const thumb = payload[fields.thumbnail];
      if (thumb && typeof thumb === "object" && !Array.isArray(thumb)) {
        const preset = (thumb as Record<string, unknown>)[fields.thumbnailImagePresetField];
        if (preset && typeof preset === "object" && !Array.isArray(preset)) {
          const presetObj = preset as Record<string, unknown>;
          const fromUid = pickAssetUidFromFileRef(presetObj.uid);
          if (fromUid) return fromUid;
          if (fields.thumbnailPresetImageField) {
            return pickAssetUidFromFileRef(presetObj[fields.thumbnailPresetImageField]);
          }
        }
      }
    }
  }
  if (fields.seoSocialGroup && fields.metaImageGroup) {
    const metaPath =
      `${fields.seoSocialGroup}.${fields.metaImageGroup}.${fields.metaImageFileField ?? "file"}`.toLowerCase();
    if (norm === metaPath || norm.includes(fields.metaImageGroup.toLowerCase())) {
      const seo = payload[fields.seoSocialGroup];
      if (seo && typeof seo === "object" && !Array.isArray(seo)) {
        const metaImage = (seo as Record<string, unknown>)[fields.metaImageGroup];
        if (metaImage && typeof metaImage === "object" && !Array.isArray(metaImage)) {
          const fileVal = (metaImage as Record<string, unknown>)[fields.metaImageFileField ?? "file"];
          return pickAssetUidFromFileRef(fileVal);
        }
      }
    }
  }
  return undefined;
}

function pickFileRefUidFromPayload(
  container: Record<string, unknown>,
  groupOrField: string,
  innerFileField?: string
): string | undefined {
  const val = container[groupOrField];
  if (val && typeof val === "object" && !Array.isArray(val) && innerFileField) {
    return pickAssetUidFromFileRef((val as Record<string, unknown>)[innerFileField]);
  }
  return pickAssetUidFromFileRef(val);
}

function pickAssetUidFromFileRef(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) return pickAssetUidFromFileRef(value[0]);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const uid = (value as { uid?: unknown }).uid;
    if (typeof uid === "string" && uid.trim()) return uid.trim();
  }
  return undefined;
}

export type UpsertEntryResult = {
  uid: string;
  warning?: string;
};

const MAX_UPSERT_RETRIES = 8;

/**
 * Create or update an entry. Optionally retries without seo.page_url or oversized image fields.
 */
export async function upsertContentstackEntryWithSeoFallback(opts: {
  cs: ContentstackManagementClient;
  contentTypeUid: string;
  payload: Record<string, unknown> & { title: string };
  locale?: string;
  existingUid?: string;
  seoFields: Pick<SeoSocialFieldUids, "seoSocialGroup" | "seoPageUrl">;
  fileImageFields?: EntryFileImageFieldUids;
  logContext?: SeoLogContext;
  /** On create, if title is not unique, find existing entry and update it instead of failing. */
  resolveDuplicateTitle?: boolean;
  /** Retry without seo.page_url when Contentstack rejects it (default true). */
  retrySeoPageUrl?: boolean;
  /** Retry without image fields when Contentstack rejects file size (default true). */
  retryImageSizeErrors?: boolean;
}): Promise<UpsertEntryResult> {
  const {
    cs,
    contentTypeUid,
    payload,
    locale,
    existingUid,
    seoFields,
    fileImageFields,
    logContext,
    resolveDuplicateTitle,
    retrySeoPageUrl = true,
    retryImageSizeErrors = true,
  } = opts;

  let body = payload;
  let entryUid = existingUid;
  const warnings: string[] = [];
  let usedAllImageOmitFallback = false;

  const attempt = async (attemptBody: Record<string, unknown> & { title: string }) => {
    if (entryUid) {
      const updated = await cs.updateEntry(contentTypeUid, entryUid, attemptBody, locale);
      return updated.uid ?? entryUid;
    }
    const created = await cs.createEntry(contentTypeUid, attemptBody, locale);
    return created.uid;
  };

  if (resolveDuplicateTitle && !entryUid) {
    try {
      const uid = await attempt(body);
      return { uid };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isTitleNotUniqueError(msg)) {
        const matches = await cs.findEntryUidsByExactTitle(contentTypeUid, body.title, locale);
        if (matches.length > 0) {
          entryUid = matches[0]!;
          console.error(
            `${seoLogPrefix(logContext)} WARNING: title "${body.title}" is not unique; ` +
              `updating existing entry ${entryUid}` +
              (matches.length > 1 ? ` (${matches.length} matches, using first)` : "")
          );
          warnings.push(`title is not unique; updated existing entry ${entryUid}`);
        }
      }
    }
  }

  for (let i = 0; i < MAX_UPSERT_RETRIES; i += 1) {
    try {
      const uid = await attempt(body);
      return {
        uid,
        warning: warnings.length > 0 ? warnings.join("; ") : undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const parsed = parseCmaEntryErrorJson(msg);
      const errorPaths = parsed?.errors ? Object.keys(parsed.errors) : [];

      if (isTitleNotUniqueError(msg) && !resolveDuplicateTitle) {
        throw new Error(
          `Contentstack entry already exists with title "${body.title}" (title is not unique); ` +
            `create-only migration does not update existing entries`
        );
      }

      if (retrySeoPageUrl && isSeoPageUrlValidationError(msg)) {
        console.error(
          `${seoLogPrefix(logContext)} WARNING: Contentstack rejected seo.page_url (${msg.slice(0, 200)}); ` +
            `retrying without page_url`
        );
        body = omitSeoPageUrlFromEntry(body, seoFields) as Record<string, unknown> & { title: string };
        warnings.push("seo.page_url omitted after CMA validation error");
        continue;
      }

      if (retryImageSizeErrors && fileImageFields && isInvalidFileUploadError(msg)) {
        const { payload: nextBody, omittedPaths } = omitEntryImageFieldsForErrorPaths(
          body,
          fileImageFields,
          errorPaths.length > 0 ? errorPaths : ["image field"]
        );

        if (omittedPaths.length === 0 && !usedAllImageOmitFallback) {
          console.error(
            `${seoLogPrefix(logContext)} WARNING: Contentstack rejected image refs (${msg.slice(0, 200)}); ` +
              `retrying without all known image fields`
          );
          const fallback = omitAllEntryImageFields(body, fileImageFields);
          body = fallback.payload as Record<string, unknown> & { title: string };
          usedAllImageOmitFallback = true;
          const omitWarning = await buildImageOmitWarnings(
            msg,
            fallback.omittedPaths,
            payload,
            fileImageFields,
            cs
          );
          warnings.push(omitWarning);
          continue;
        }

        if (omittedPaths.length > 0) {
          console.error(
            `${seoLogPrefix(logContext)} WARNING: Contentstack rejected image refs (${msg.slice(0, 200)}); ` +
              `retrying without: ${omittedPaths.join(", ")}`
          );
          body = nextBody as Record<string, unknown> & { title: string };
          const omitWarning = await buildImageOmitWarnings(
            msg,
            omittedPaths,
            payload,
            fileImageFields,
            cs
          );
          warnings.push(omitWarning);
          continue;
        }
      }

      throw e;
    }
  }

  throw new Error(
    `${seoLogPrefix(logContext)} upsert retries exhausted after omitting recoverable fields`
  );
}
