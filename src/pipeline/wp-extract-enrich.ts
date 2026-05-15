import type { WordPressClient } from "../wordpress/client.js";
import type { TrackingRow } from "./types.js";

/** Normalize URL for stable row / Mongo identity (trim, drop trailing slashes, collapse spaces). */
export function normalizedUrlKey(url: string): string {
  return url.trim().replace(/\/+$/g, "").replace(/\s+/g, " ");
}

/**
 * Infer numeric WordPress object ID from a URL when the sheet has no ID column.
 * Handles query vars, REST URLs, and plain path endings like `/123/`.
 */
export function inferWpIdFromUrl(url: string): number | undefined {
  const t = url.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    for (const key of ["p", "page_id", "post", "attachment_id", "attachment"]) {
      const raw = u.searchParams.get(key);
      if (!raw) continue;
      const n = Number(raw.trim());
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    const m = u.pathname.match(/\/wp-json\/wp\/v2\/[^/]+\/(\d+)\/?$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    const tail = u.pathname.replace(/\/+$/, "").split("/").pop();
    if (tail && /^\d{1,12}$/.test(tail)) {
      const n = Number(tail);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function wpCollectionBase(restPath: string): string {
  return restPath.replace(/^\//, "").replace(/\/$/, "");
}

/** Last meaningful path segment as a REST `slug=` candidate (skips feed, page, etc.). */
export function extractSlugFromPublicUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    const parts = u.pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i]!;
      const low = seg.toLowerCase();
      if (["feed", "embed", "trackback", "page", "wp-admin", "wp-content", "wp-json", "index.php"].includes(low)) {
        continue;
      }
      if (/^\d{1,12}$/.test(seg)) continue;
      if (seg.length > 200) continue;
      return seg;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function trailingNumericPathId(url: string): number | undefined {
  try {
    const u = new URL(url.trim());
    const tail = u.pathname.replace(/\/+$/, "").split("/").pop();
    if (!tail || !/^\d{1,12}$/.test(tail)) return undefined;
    const n = Number(tail);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    return undefined;
  }
  return undefined;
}

async function resolveIdBySlug(wp: WordPressClient, collectionBase: string, slug: string): Promise<number | undefined> {
  const items = await wp.getJson<Array<{ id?: number; slug?: string }>>(collectionBase, {
    slug,
    per_page: "10",
  });
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const exact = items.find((x) => String(x.slug ?? "").toLowerCase() === slug.toLowerCase());
  const pick = exact ?? items[0];
  const id = pick?.id;
  if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.floor(id);
  return undefined;
}

async function probeExists(wp: WordPressClient, collectionBase: string, id: number): Promise<boolean> {
  try {
    await wp.getJson<unknown>(`${collectionBase}/${id}`);
    return true;
  } catch {
    return false;
  }
}

function pickRenderedTitle(title: unknown): string {
  if (typeof title === "string") return title.trim();
  if (title && typeof title === "object" && "rendered" in title) {
    return String((title as { rendered?: string }).rendered ?? "").trim();
  }
  return "";
}

function summarizeWpEntity(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const titleRendered = pickRenderedTitle(o.title);
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const slug = typeof o.slug === "string" ? o.slug : "";
  const out: Record<string, unknown> = {
    id: o.id,
    slug,
    type: o.type,
    status: o.status,
    link: o.link,
    title: name || titleRendered || slug,
    date: o.date,
    modified: o.modified,
    author: o.author,
    featured_media: o.featured_media,
    parent: o.parent,
    template: o.template,
    format: o.format,
    mime_type: o.mime_type,
    source_url: o.source_url,
    media_type: o.media_type,
    taxonomy: o.taxonomy,
    description:
      typeof o.description === "string"
        ? o.description
        : pickRenderedTitle(o.description),
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") delete out[k];
  }
  return out;
}

function capJson(obj: Record<string, unknown>, maxBytes: number): string {
  let cur: Record<string, unknown> = { ...obj };
  let raw = JSON.stringify(cur);
  while (Buffer.byteLength(raw, "utf8") > maxBytes && Object.keys(cur).length > 1) {
    const ks = Object.keys(cur);
    const drop = ks[ks.length - 1]!;
    const { [drop]: _, ...rest } = cur;
    cur = rest;
    raw = JSON.stringify(cur);
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return JSON.stringify({ _truncated: true, id: cur.id, slug: cur.slug, title: cur.title });
  }
  return raw;
}

function applySnapshot(row: TrackingRow, snap: Record<string, unknown>, maxJsonBytes: number): void {
  row.wp_slug = typeof snap.slug === "string" ? snap.slug : "";
  row.wp_title = typeof snap.title === "string" ? snap.title : "";
  row.wp_status = typeof snap.status === "string" ? snap.status : "";
  row.wp_type = typeof snap.type === "string" ? snap.type : "";
  row.wp_link = typeof snap.link === "string" ? snap.link : "";
  row.wp_extract_json = capJson(snap, maxJsonBytes);
}

/**
 * Resolve missing IDs from URLs, then fetch each row from WordPress REST and fill `wp_*` snapshot fields.
 * Mutates rows in place. Skips rows with empty `wp_rest_path` or invalid collection path.
 */
export async function enrichTrackingRowsFromWordPress(
  rows: TrackingRow[],
  wp: WordPressClient,
  maxJsonBytes = 80_000
): Promise<void> {
  for (const row of rows) {
    const base = wpCollectionBase(row.wp_rest_path);
    if (!base.includes("wp-json")) continue;

    try {
      if (row.wp_id <= 0 && row.url.trim()) {
        let id = inferWpIdFromUrl(row.url);
        if (!id) {
          const slug = extractSlugFromPublicUrl(row.url);
          if (slug) id = await resolveIdBySlug(wp, base, slug);
        }
        if (!id) {
          const n = trailingNumericPathId(row.url);
          if (n && (await probeExists(wp, base, n))) id = n;
        }
        if (id && id > 0) {
          row.wp_id = id;
          row.migration_status = "Pending";
          row.migration_message = "";
        }
      }

      if (row.wp_id > 0) {
        const raw = await wp.getJson<unknown>(`${base}/${row.wp_id}`);
        const snap = summarizeWpEntity(raw);
        if (Object.keys(snap).length === 0) {
          row.migration_message = "extract wp: unrecognized REST entity shape";
        } else {
          applySnapshot(row, snap, maxJsonBytes);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      row.migration_message = `extract wp: ${msg}`.slice(0, 800);
      if (row.wp_id <= 0) row.migration_status = "NoWpId";
    }
  }
}
