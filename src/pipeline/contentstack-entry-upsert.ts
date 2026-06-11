import type { ContentstackManagementClient } from "../contentstack/client.js";
import {
  isInvalidFileUploadError,
  isSeoPageUrlValidationError,
  omitEntryFileImageFields,
  omitSeoPageUrlFromEntry,
  type EntryFileImageFieldUids,
  type SeoLogContext,
  type SeoSocialFieldUids,
} from "./seo-social-payload.js";

function seoLogPrefix(ctx?: SeoLogContext): string {
  if (ctx?.wpId != null) return `[${ctx.entity ?? "seo"}] wp_id=${ctx.wpId}`;
  return `[${ctx?.entity ?? "seo"}]`;
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
          `retrying without banner_image.file and seo.meta_image.file`
      );

      const stripped = omitEntryFileImageFields(payload, fileImageFields) as Record<string, unknown> & {
        title: string;
      };
      const uid = await attempt(stripped);
      return {
        uid,
        warning:
          "banner_image.file and seo.meta_image.file omitted after CMA validation error (see console WARNING)",
      };
    }

    throw e;
  }
}
