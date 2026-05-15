/**
 * Contentstack Management API URLs for tracking (identify migrated resources in stack).
 * Optional env overrides use placeholders: {entry_uid}, {content_type_uid}, {locale}, {stack_api_key}, {api_host}, {asset_uid}.
 */
export function buildContentstackEntryTargetUrl(opts: {
  apiHost: string;
  stackApiKey: string;
  contentTypeUid: string;
  entryUid: string;
  locale?: string;
}): string {
  const tmpl = process.env.CONTENTSTACK_ENTRY_TARGET_URL_TEMPLATE?.trim();
  if (tmpl) {
    return applyTemplate(tmpl, {
      entry_uid: opts.entryUid,
      content_type_uid: opts.contentTypeUid,
      locale: opts.locale ?? "",
      stack_api_key: opts.stackApiKey,
      api_host: opts.apiHost,
    });
  }
  const base = `https://${opts.apiHost}/v3/content_types/${encodeURIComponent(opts.contentTypeUid)}/entries/${encodeURIComponent(opts.entryUid)}`;
  return opts.locale ? `${base}?locale=${encodeURIComponent(opts.locale)}` : base;
}

export function buildContentstackAssetTargetUrl(opts: { apiHost: string; stackApiKey: string; assetUid: string }): string {
  const tmpl = process.env.CONTENTSTACK_ASSET_TARGET_URL_TEMPLATE?.trim();
  if (tmpl) {
    return applyTemplate(tmpl, {
      asset_uid: opts.assetUid,
      stack_api_key: opts.stackApiKey,
      api_host: opts.apiHost,
    });
  }
  return `https://${opts.apiHost}/v3/assets/${encodeURIComponent(opts.assetUid)}`;
}

function applyTemplate(tmpl: string, vars: Record<string, string>): string {
  let s = tmpl;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(v);
  }
  return s;
}

/** Target CMA URL after media migration (asset vs video/document entry). */
export function buildContentstackMediaMigrationTargetUrl(opts: {
  apiHost: string;
  stackApiKey: string;
  resultType: string;
  uid: string;
  locale?: string;
}): string {
  if (opts.resultType === "asset") {
    return buildContentstackAssetTargetUrl({
      apiHost: opts.apiHost,
      stackApiKey: opts.stackApiKey,
      assetUid: opts.uid,
    });
  }
  if (opts.resultType === "entry:video") {
    const ct = process.env.CS_CONTENT_TYPE_VIDEO?.trim();
    if (!ct) return "";
    return buildContentstackEntryTargetUrl({
      apiHost: opts.apiHost,
      stackApiKey: opts.stackApiKey,
      contentTypeUid: ct,
      entryUid: opts.uid,
      locale: opts.locale,
    });
  }
  if (opts.resultType === "entry:document") {
    const ct = process.env.CS_CONTENT_TYPE_DOCUMENT?.trim();
    if (!ct) return "";
    return buildContentstackEntryTargetUrl({
      apiHost: opts.apiHost,
      stackApiKey: opts.stackApiKey,
      contentTypeUid: ct,
      entryUid: opts.uid,
      locale: opts.locale,
    });
  }
  return "";
}
