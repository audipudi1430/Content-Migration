import type { ContentstackManagementClient } from "../contentstack/client.js";
import { formatFileSizeBytes } from "./image-size-limit.js";
import {
  isInvalidFileUploadError,
  isSeoPageUrlValidationError,
  omitEntryFileImageFields,
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

async function buildFileImageOmitWarning(
  msg: string,
  payload: Record<string, unknown>,
  fields: EntryFileImageFieldUids,
  cs: ContentstackManagementClient
): Promise<string> {
  const parsed = parseCmaEntryErrorJson(msg);
  const errorPaths = parsed?.errors ? Object.keys(parsed.errors) : [];
  const paths = errorPaths.length > 0 ? errorPaths : ["file image field"];

  const parts: string[] = [];
  for (const path of paths) {
    const detail = parsed?.errors?.[path]?.[0] ?? msg;
    const limit = parseSizeLimitFromErrorDetail(detail);
    const assetUid = resolveAssetUidForOmitWarning(payload, fields, path);
    let sizePart = "";
    if (assetUid) {
      const bytes = await cs.getAssetFileSizeBytes(assetUid);
      if (bytes) sizePart = `actual file size ${formatFileSizeBytes(bytes)}`;
    }
    const limitPart = limit ? `limit ${limit}` : "";
    const meta = [sizePart, limitPart].filter(Boolean).join("; ");
    parts.push(
      `${path} omitted after CMA validation error` + (meta ? ` (${meta})` : `: ${detail.slice(0, 120)}`)
    );
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

/**
 * Create or update an entry. On `seo.page_url` validation errors, retry without page_url and warn.
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
}): Promise<UpsertEntryResult> {
  const { cs, contentTypeUid, payload, locale, existingUid, seoFields, fileImageFields, logContext } = opts;

  const attempt = async (body: Record<string, unknown> & { title: string }) => {
    if (existingUid) {
      const updated = await cs.updateEntry(contentTypeUid, existingUid, body, locale);
      return updated.uid ?? existingUid;
    }
    const created = await cs.createEntry(contentTypeUid, body, locale);
    return created.uid;
  };

  try {
    const uid = await attempt(payload);
    return { uid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    if (isSeoPageUrlValidationError(msg)) {
      console.error(
        `${seoLogPrefix(logContext)} WARNING: Contentstack rejected seo.page_url (${msg.slice(0, 200)}); ` +
          `retrying without page_url`
      );

      const stripped = omitSeoPageUrlFromEntry(payload, seoFields) as Record<string, unknown> & {
        title: string;
      };
      const uid = await attempt(stripped);
      return {
        uid,
        warning: "seo.page_url omitted after CMA validation error (see console WARNING)",
      };
    }

    if (isInvalidFileUploadError(msg) && fileImageFields) {
      console.error(
        `${seoLogPrefix(logContext)} WARNING: Contentstack rejected file image refs (${msg.slice(0, 200)}); ` +
          `retrying without rejected file fields`
      );

      const stripped = omitEntryFileImageFields(payload, fileImageFields) as Record<string, unknown> & {
        title: string;
      };
      const uid = await attempt(stripped);
      const warning = await buildFileImageOmitWarning(msg, payload, fileImageFields, cs);
      return { uid, warning };
    }

    throw e;
  }
}
