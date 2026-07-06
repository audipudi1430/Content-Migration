/** Contentstack `links` content type field UIDs (ExternalLink / InternalLink). */
export type LinksFieldUids = {
  contentTypeUid: string;
  title: string;
  url: string;
  template: string;
  linkedText: string;
  shortLinkedText: string;
  openInNewTab: string;
  targetUrl: string;
  linkAsset: string;
  assetType: string;
  description: string;
};

export function loadLinksContentTypeUid(): string {
  return process.env.BLOG_BODY_LINKS_CONTENT_TYPE?.trim() || process.env.CS_CONTENT_TYPE_LINKS?.trim() || "links";
}

export function loadBlogBodyLinksEnabled(): boolean {
  const raw = (process.env.BLOG_BODY_LINKS_ENABLED ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

export function loadLinksFieldUids(): LinksFieldUids {
  return {
    contentTypeUid: loadLinksContentTypeUid(),
    title: process.env.LINKS_FIELD_TITLE ?? "title",
    url: process.env.LINKS_FIELD_URL ?? "url",
    template: process.env.LINKS_FIELD_TEMPLATE ?? "template",
    linkedText: process.env.LINKS_FIELD_LINKED_TEXT ?? "linked_text",
    shortLinkedText: process.env.LINKS_FIELD_SHORT_LINKED_TEXT ?? "short_linked_text",
    openInNewTab: process.env.LINKS_FIELD_OPEN_IN_NEW_TAB ?? "open_in_new_tab",
    targetUrl: process.env.LINKS_FIELD_TARGET_URL ?? "target_url",
    linkAsset: process.env.LINKS_FIELD_LINK_ASSET ?? "link_asset",
    assetType: process.env.LINKS_FIELD_ASSET_TYPE ?? "asset_type",
    description: process.env.LINKS_FIELD_DESCRIPTION ?? "description",
  };
}

/** Hostnames treated as internal (same-tab per Links schema). */
export function isBroadcomInternalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "broadcom.com" || h.endsWith(".broadcom.com") || h === "broadcom.cn" || h.endsWith(".broadcom.cn");
}
