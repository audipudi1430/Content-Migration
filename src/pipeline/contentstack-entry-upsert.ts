import type { ContentstackManagementClient } from "../contentstack/client.js";
import {
  isSeoPageUrlValidationError,
  omitSeoPageUrlFromEntry,
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
  logContext?: SeoLogContext;
}): Promise<UpsertEntryResult> {
  const { cs, contentTypeUid, payload, locale, existingUid, seoFields, logContext } = opts;

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
    if (!isSeoPageUrlValidationError(msg)) {
      throw e;
    }

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
}
