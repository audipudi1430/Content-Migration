import type { ContentstackManagementClient } from "../contentstack/client.js";
import { parseCategorySheetColumns, isCategorySourceSheetRow } from "./blog-category-sheet.js";
import { normalizeWpText } from "./contentstack-rte.js";
import type { MigrationWarnings } from "./image-size-limit.js";
import type { TrackingRow } from "./types.js";

function namesMatch(a: string, b: string): boolean {
  return normalizeWpText(a).toLowerCase() === normalizeWpText(b).toLowerCase();
}

function isAuthorTrackingRow(row: TrackingRow): boolean {
  if (row.row_kind !== "content") return false;
  const ct = row.content_type_uid.trim().toLowerCase();
  if (ct === "blog_author" || ct.endsWith("blog_author")) return true;
  const tab = row.source_sheet.trim().toLowerCase();
  return tab === "blog_author" || tab.includes("author");
}

function findAuthorUidInTracking(name: string, allTracking: TrackingRow[]): string | undefined {
  for (const row of allTracking) {
    if (!isAuthorTrackingRow(row)) continue;
    if (row.migration_status !== "Pass" || !row.contentstack_entry_uid?.trim()) continue;
    if (namesMatch(row.wp_title, name)) return row.contentstack_entry_uid.trim();
  }
  return undefined;
}

function findCategoryUidInTracking(name: string, allTracking: TrackingRow[]): string | undefined {
  for (const row of allTracking) {
    if (row.row_kind !== "content") continue;
    if (!isCategorySourceSheetRow(row)) continue;
    if (row.migration_status !== "Pass" || !row.contentstack_entry_uid?.trim()) continue;
    if (namesMatch(row.wp_title, name)) return row.contentstack_entry_uid.trim();
    const sheet = parseCategorySheetColumns(row);
    if (sheet.categoryName && namesMatch(sheet.categoryName, name)) {
      return row.contentstack_entry_uid.trim();
    }
  }
  return undefined;
}

/** Resolve a `blog_author` entry UID by display name (tracking → CMA title match). */
export async function resolveBlogAuthorUidByName(opts: {
  name: string;
  cs: ContentstackManagementClient;
  authorContentTypeUid: string;
  allTracking: TrackingRow[];
  locale?: string;
  warnings?: MigrationWarnings;
}): Promise<string | undefined> {
  const label = normalizeWpText(opts.name);
  if (!label || label.toLowerCase() === "none") return undefined;

  const fromTracking = findAuthorUidInTracking(label, opts.allTracking);
  if (fromTracking) return fromTracking;

  const matches = await opts.cs.findEntryUidsByExactTitle(
    opts.authorContentTypeUid,
    label,
    opts.locale
  );
  if (matches.length > 0) return matches[0];

  opts.warnings?.add(`blog_author_profile: author not found for "${label}"`);
  return undefined;
}

/** Resolve a `blog_category` entry UID by name (tracking → CMA title match). */
export async function resolveBlogCategoryUidByName(opts: {
  name: string;
  cs: ContentstackManagementClient;
  categoryContentTypeUid: string;
  allTracking: TrackingRow[];
  locale?: string;
  warnings?: MigrationWarnings;
}): Promise<string | undefined> {
  const label = normalizeWpText(opts.name);
  if (!label) return undefined;

  const fromTracking = findCategoryUidInTracking(label, opts.allTracking);
  if (fromTracking) return fromTracking;

  const matches = await opts.cs.findEntryUidsByExactTitle(
    opts.categoryContentTypeUid,
    label,
    opts.locale
  );
  if (matches.length > 0) return matches[0];

  opts.warnings?.add(`blog_category: category not found for "${label}"`);
  return undefined;
}

/** Resolve many category names; preserves order and dedupes UIDs. */
export async function resolveBlogCategoryUidsByNames(opts: {
  names: string[];
  cs: ContentstackManagementClient;
  categoryContentTypeUid: string;
  allTracking: TrackingRow[];
  locale?: string;
  warnings?: MigrationWarnings;
}): Promise<string[]> {
  const uids: string[] = [];
  const seen = new Set<string>();
  for (const name of opts.names) {
    const uid = await resolveBlogCategoryUidByName({
      name,
      cs: opts.cs,
      categoryContentTypeUid: opts.categoryContentTypeUid,
      allTracking: opts.allTracking,
      locale: opts.locale,
      warnings: opts.warnings,
    });
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      uids.push(uid);
    }
  }
  return uids;
}
