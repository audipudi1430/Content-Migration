import { createHash } from "node:crypto";
import type { ContentstackManagementClient } from "../contentstack/client.js";
import { MappingStore } from "../mapping-store.js";
import {
  isBroadcomInternalHostname,
  loadLinksFieldUids,
  type LinksFieldUids,
} from "./blog-link-config.js";
import type { BlogBodyBlockUids } from "./blog-body-config.js";
import { htmlToPlainWithBreaks, sanitizeBodyHtmlForContentstack } from "./contentstack-rte.js";
import type { MigrationWarnings } from "./image-size-limit.js";
import { normalizeMigrationUrlPath } from "./migration-url.js";
import { isTitleNotUniqueError } from "./seo-social-payload.js";
import type { TrackingRow } from "./types.js";

export type ContentstackEmbeddedLink = {
  entryUid: string;
  contentTypeUid: string;
  locale: string;
  href: string;
  linkedText: string;
  openInNewTab: boolean;
};

export type BodyLinkResolver = (opts: {
  href: string;
  linkedText: string;
  target?: string;
  rel?: string;
}) => Promise<ContentstackEmbeddedLink | undefined>;

function pickString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slugifyLinkTitle(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "link"
  );
}

function normalizeLinkHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  if (/^(mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function absoluteLinkHref(href: string, baseUrl?: string): string {
  const normalized = normalizeLinkHref(href);
  if (/^(https?:|mailto:|tel:|#)/i.test(normalized)) return normalized;
  if (!baseUrl) return normalized;
  try {
    return new URL(normalized, baseUrl).href;
  } catch {
    return normalized;
  }
}

function linkMapSourceKey(href: string, linkedText: string): string {
  const h = absoluteLinkHref(href).toLowerCase();
  const t = linkedText.trim().toLowerCase().slice(0, 200);
  return `link:${h}:${t}`;
}

function linkEntryTitle(linkedText: string, href: string): string {
  const text = linkedText.trim() || href.trim();
  const hash = createHash("sha256").update(`${href}|${linkedText}`).digest("hex").slice(0, 8);
  const base = text.slice(0, 180);
  return base ? `${base} (${hash})` : `Link (${hash})`;
}

function pickTargetAttr(rawAttrs: string): string | undefined {
  const m = /target\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttrs);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function pickRelAttr(rawAttrs: string): string | undefined {
  const m = /rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttrs);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function pickHrefFromAnchorAttrs(rawAttrs: string): string | undefined {
  const m = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttrs);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function isAlreadyEmbeddedEntryAnchor(rawAttrs: string): boolean {
  return /type\s*=\s*["']entry["']/i.test(rawAttrs) || /embedded-entry/i.test(rawAttrs);
}

function plainLinkedText(innerHtml: string): string {
  return htmlToPlainWithBreaks(innerHtml).replace(/\s+/g, " ").trim();
}

function resolveOpenInNewTab(
  href: string,
  target?: string,
  internalEntry?: { uid: string; contentTypeUid: string }
): boolean {
  if (internalEntry) return false;
  if (target?.toLowerCase() === "_blank") return true;
  try {
    const host = new URL(href, "https://www.broadcom.com").hostname;
    return !isBroadcomInternalHostname(host);
  } catch {
    return true;
  }
}

type InternalLinkTarget = {
  uid: string;
  contentTypeUid: string;
  pagePath?: string;
};

function findMigratedEntryForHref(
  href: string,
  allTracking: TrackingRow[],
  wpBaseUrl?: string
): InternalLinkTarget | undefined {
  const absolute = absoluteLinkHref(href, wpBaseUrl);
  let targetPath = "";
  try {
    targetPath = normalizeMigrationUrlPath(new URL(absolute, "https://www.broadcom.com").pathname);
  } catch {
    targetPath = normalizeMigrationUrlPath(absolute);
  }
  if (!targetPath) return undefined;

  for (const row of allTracking) {
    if (row.migration_status !== "Pass") continue;
    const uid = row.contentstack_entry_uid?.trim();
    const ct = row.content_type_uid?.trim();
    if (!uid || !ct) continue;

    const candidates = [
      normalizeMigrationUrlPath(row.new_url),
      normalizeMigrationUrlPath(row.url),
      normalizeMigrationUrlPath(row.wp_link),
      normalizeMigrationUrlPath(row.target_url),
    ].filter(Boolean);

    if (candidates.includes(targetPath)) {
      return {
        uid,
        contentTypeUid: ct,
        pagePath: pickString(row.new_url) || pickString(row.url) || targetPath,
      };
    }
  }
  return undefined;
}

function embeddedLinkAnchorHtml(link: ContentstackEmbeddedLink): string {
  const targetAttr = link.openInNewTab ? ' target="_blank"' : "";
  return (
    `<a${targetAttr} type="entry" class="embedded-entry redactor-component block-entry" ` +
    `href="${escapeHtmlAttr(link.href)}" data-sys-entry-uid="${escapeHtmlAttr(link.entryUid)}" ` +
    `data-sys-entry-locale="${escapeHtmlAttr(link.locale)}" ` +
    `data-sys-content-type-uid="${escapeHtmlAttr(link.contentTypeUid)}" sys-style-type="link">` +
    `${escapeHtmlAttr(link.linkedText)}</a>`
  );
}

/** Ensure a visible space around inline anchors when Gutenberg omits whitespace. */
export function ensureEmbeddedLinkSpacing(html: string): string {
  let out = html;
  out = out.replace(/(<\/(?:em|strong|b|i|u|span|sub|sup)>)(<a\b)/gi, "$1 $2");
  out = out.replace(/([A-Za-z0-9])(<a\b)/g, "$1 $2");
  out = out.replace(/(<\/a>)([A-Za-z0-9])/g, "$1 $2");
  return out;
}

async function createLinkEntryWithDuplicateFallback(
  cs: ContentstackManagementClient,
  contentTypeUid: string,
  payload: Record<string, unknown> & { title: string },
  locale: string | undefined,
  purpose: string
): Promise<string> {
  try {
    const created = await cs.createEntry(contentTypeUid, payload, locale);
    return created.uid;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isTitleNotUniqueError(msg)) throw e;
    const matches = await cs.findEntryUidsByExactTitle(contentTypeUid, payload.title, locale);
    if (matches.length === 0) throw e;
    const existingUid = matches[0]!;
    console.error(
      `[link] ${purpose} WARNING: title "${payload.title}" is not unique; updating existing entry ${existingUid}`
    );
    const updated = await cs.updateEntry(contentTypeUid, existingUid, payload, locale);
    return updated.uid ?? existingUid;
  }
}

export async function ensureContentstackLinkEntry(opts: {
  href: string;
  linkedText: string;
  target?: string;
  rel?: string;
  cs: ContentstackManagementClient;
  map: MappingStore;
  fields: LinksFieldUids;
  locale?: string;
  allTracking: TrackingRow[];
  wpBaseUrl?: string;
  purpose: string;
  warnings?: MigrationWarnings;
}): Promise<ContentstackEmbeddedLink | undefined> {
  const hrefRaw = opts.href?.trim();
  if (!hrefRaw || hrefRaw.startsWith("#")) return undefined;

  const linkedText = opts.linkedText.trim() || plainLinkedText(hrefRaw);
  const absoluteHref = absoluteLinkHref(hrefRaw, opts.wpBaseUrl);
  const sourceKey = linkMapSourceKey(absoluteHref, linkedText);
  const locale = (opts.locale ?? "en-us").trim() || "en-us";

  const cached = opts.map.get("custom", 0, locale, sourceKey);
  if (cached?.contentstackUid) {
    return {
      entryUid: cached.contentstackUid,
      contentTypeUid: opts.fields.contentTypeUid,
      locale,
      href: absoluteHref,
      linkedText,
      openInNewTab: resolveOpenInNewTab(absoluteHref, opts.target),
    };
  }

  const internalTarget = findMigratedEntryForHref(absoluteHref, opts.allTracking, opts.wpBaseUrl);
  const openInNewTab = resolveOpenInNewTab(absoluteHref, opts.target, internalTarget);
  const title = linkEntryTitle(linkedText, absoluteHref);
  const pageSlug = slugifyLinkTitle(title);

  const payload: Record<string, unknown> & { title: string } = {
    title,
    [opts.fields.url]: `/${pageSlug}`,
    [opts.fields.template]: internalTarget ? "InternalLink" : "ExternalLink",
    [opts.fields.linkedText]: linkedText,
    [opts.fields.shortLinkedText]: "",
    [opts.fields.assetType]: "Page",
    [opts.fields.description]: "",
    [opts.fields.linkAsset]: internalTarget
      ? [{ uid: internalTarget.uid, _content_type_uid: internalTarget.contentTypeUid }]
      : [],
  };

  if (internalTarget) {
    payload[opts.fields.openInNewTab] = "No";
  } else {
    payload[opts.fields.targetUrl] = absoluteHref;
    payload[opts.fields.openInNewTab] = openInNewTab ? "Yes" : "No";
  }

  try {
    const entryUid = await createLinkEntryWithDuplicateFallback(
      opts.cs,
      opts.fields.contentTypeUid,
      payload,
      locale,
      opts.purpose
    );

    opts.map.set({
      wpId: 0,
      kind: "custom",
      contentstackUid: entryUid,
      sourceKey,
      migratedAt: new Date().toISOString(),
      locale,
    });
    await opts.map.save().catch(() => undefined);

    console.error(
      `[link] created ${internalTarget ? "InternalLink" : "ExternalLink"} uid=${entryUid} ` +
        `(${opts.purpose}) text="${linkedText.slice(0, 60)}" href=${absoluteHref.slice(0, 120)}`
    );

    return {
      entryUid,
      contentTypeUid: opts.fields.contentTypeUid,
      locale,
      href: absoluteHref,
      linkedText,
      openInNewTab,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const warning = `${opts.purpose}: link entry not created for "${linkedText.slice(0, 40)}" → ${absoluteHref.slice(0, 120)} (${msg.slice(0, 160)})`;
    opts.warnings?.add(warning);
    console.error(`[link] WARNING: ${warning}`);
    return undefined;
  }
}

/** Replace `<a href="…">` tags with Contentstack embedded link entry anchors. */
export async function transformBodyHtmlLinks(
  html: string,
  resolveLink: BodyLinkResolver,
  log?: (msg: string) => void
): Promise<string> {
  const input = sanitizeBodyHtmlForContentstack(html);
  if (!input || !/<a\b/i.test(input)) return input;

  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    parts.push(input.slice(lastIndex, m.index));
    const rawAttrs = m[1] ?? "";
    const innerHtml = m[2] ?? "";

    if (isAlreadyEmbeddedEntryAnchor(rawAttrs)) {
      parts.push(m[0] ?? "");
      lastIndex = m.index + (m[0]?.length ?? 0);
      continue;
    }

    const href = pickHrefFromAnchorAttrs(rawAttrs);
    if (!href) {
      parts.push(m[0] ?? "");
      lastIndex = m.index + (m[0]?.length ?? 0);
      continue;
    }

    const linkedText = plainLinkedText(innerHtml) || href;
    const embedded = await resolveLink({
      href,
      linkedText,
      target: pickTargetAttr(rawAttrs),
      rel: pickRelAttr(rawAttrs),
    });

    if (embedded) {
      parts.push(embeddedLinkAnchorHtml(embedded));
    } else {
      log?.(`link not embedded: href=${href.slice(0, 120)} text="${linkedText.slice(0, 60)}"`);
      parts.push(m[0] ?? "");
    }

    lastIndex = m.index + (m[0]?.length ?? 0);
  }

  parts.push(input.slice(lastIndex));
  return ensureEmbeddedLinkSpacing(parts.join(""));
}

export async function transformLinksInModularBlocks(
  blocks: Record<string, unknown>[],
  uids: BlogBodyBlockUids,
  resolveLink: BodyLinkResolver,
  log?: (msg: string) => void
): Promise<void> {
  const textUid = uids.text.blockUid;
  const textField = uids.text.text;

  for (const block of blocks) {
    const inner = block[textUid];
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;

    const fields = inner as Record<string, unknown>;
    const html = pickString(fields[textField]);
    if (!html || !/<a\b/i.test(html)) continue;

    fields[textField] = await transformBodyHtmlLinks(html, resolveLink, log);
  }
}
