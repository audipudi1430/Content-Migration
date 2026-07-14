import { loadConfig } from "../config.js";
import { loadPipelinePaths } from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { initPipelineEnv, numberArg, stringArg } from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import { loadBlogFieldUids } from "./blog-config.js";
import { normalizeMigrationUrlPath } from "./migration-url.js";
import {
  buildSeoPageUrlValue,
  loadSharedSeoPageUrlFields,
  resolveSeoPageUrlShape,
  type SeoSocialFieldUids,
} from "./seo-social-payload.js";
import {
  defaultEntryUrlUpdateWorkbookPath,
  readEntryUrlUpdateWorkbook,
  writeEntryUrlUpdateWorkbook,
  type EntryUrlUpdateRow,
} from "./update-entry-urls-sheet.js";

function loadUrlUpdateFieldUids(): {
  urlField: string;
  seoGroup: string;
  pageUrlField: string;
  canonicalField: string;
  seoFields: SeoSocialFieldUids;
} {
  const blog = loadBlogFieldUids();
  const shared = loadSharedSeoPageUrlFields();
  const seoGroup =
    process.env.UPDATE_ENTRY_URL_SEO_GROUP?.trim() ||
    process.env.BLOG_FIELD_SEO_SOCIAL_GROUP?.trim() ||
    blog.seoSocialGroup ||
    "seo";
  const pageUrlField =
    process.env.UPDATE_ENTRY_URL_SEO_PAGE_URL?.trim() ||
    process.env.BLOG_FIELD_SEO_PAGE_URL?.trim() ||
    blog.seoPageUrl ||
    "page_url";
  const urlField =
    process.env.UPDATE_ENTRY_URL_FIELD?.trim() || process.env.BLOG_FIELD_URL?.trim() || blog.url || "url";
  const canonicalField =
    process.env.UPDATE_ENTRY_URL_CANONICAL_FIELD?.trim() ||
    shared.seoPageUrlCanonicalField ||
    "canonical";

  const shape = resolveSeoPageUrlShape(
    process.env.UPDATE_ENTRY_URL_SEO_PAGE_URL_SHAPE ?? process.env.BLOG_SEO_PAGE_URL_SHAPE,
    "canonical_url_list"
  );

  const seoFields: SeoSocialFieldUids = {
    ...blog,
    seoSocialGroup: seoGroup,
    seoPageUrl: pageUrlField,
    seoPageUrlShape: shape,
    ...shared,
    seoPageUrlCanonicalField: canonicalField,
  };

  return { urlField, seoGroup, pageUrlField, canonicalField, seoFields };
}

function resolveDefaultContentTypeUid(argv: string[]): string {
  return (
    stringArg(argv, "--content-type")?.trim() ||
    process.env.UPDATE_ENTRY_URL_CONTENT_TYPE?.trim() ||
    process.env.CS_CONTENT_TYPE_BLOG?.trim() ||
    process.env.MIGRATION_CONTENT_TYPE_UID?.trim() ||
    ""
  );
}

function resolveDefaultLocale(argv: string[]): string {
  return (
    stringArg(argv, "--locale")?.trim() ||
    process.env.UPDATE_ENTRY_URL_LOCALE?.trim() ||
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    "en-us"
  );
}

function loadConcurrency(argv: string[]): number {
  const raw =
    stringArg(argv, "--concurrency") ?? process.env.UPDATE_ENTRY_URL_CONCURRENCY ?? "4";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 4;
}

function parseUidList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

function resolveSelection(argv: string[]): {
  mode: "all" | "single" | "ids";
  uids: string[];
} {
  const modeRaw = (
    stringArg(argv, "--mode") ??
    process.env.UPDATE_ENTRY_URL_MODE ??
    "all"
  )
    .trim()
    .toLowerCase();
  const mode = modeRaw === "single" || modeRaw === "ids" ? modeRaw : "all";
  const uids = parseUidList(
    stringArg(argv, "--uid") ??
      stringArg(argv, "--uids") ??
      stringArg(argv, "--cs-uids") ??
      process.env.UPDATE_ENTRY_URL_UIDS
  );
  return { mode, uids };
}

function shouldSkipExisting(row: EntryUrlUpdateRow, skipPass: boolean): boolean {
  return Boolean(skipPass && row.update_status === "Pass");
}

function readCanonicalFromSeo(
  seo: Record<string, unknown> | undefined,
  pageUrlField: string,
  canonicalField: string
): string {
  if (!seo) return "";
  const pageUrl = seo[pageUrlField];
  if (typeof pageUrl === "string") return pageUrl.trim();
  if (!pageUrl || typeof pageUrl !== "object" || Array.isArray(pageUrl)) return "";
  const obj = pageUrl as Record<string, unknown>;
  const canonical = obj[canonicalField];
  if (typeof canonical === "string") return canonical.trim();
  return "";
}

/**
 * Patch only top-level `url` and `seo.page_url.canonical`.
 * All other entry fields and SEO fields (including url_list) stay as-is.
 */
export function buildEntryUrlUpdatePayload(opts: {
  existing: Record<string, unknown>;
  updatedPath: string;
  urlField: string;
  seoGroup: string;
  pageUrlField: string;
  canonicalField: string;
  seoFields: SeoSocialFieldUids;
}): { title: string; url: string; seo: Record<string, unknown>; previousUrl: string; previousCanonical: string } {
  const title = String(opts.existing.title ?? "").trim() || "untitled";
  const previousUrl = String(opts.existing[opts.urlField] ?? "").trim();

  // Deep-ish clone seo so CMA replace of the group does not drop sibling fields.
  const existingSeo =
    opts.existing[opts.seoGroup] &&
    typeof opts.existing[opts.seoGroup] === "object" &&
    !Array.isArray(opts.existing[opts.seoGroup])
      ? (JSON.parse(JSON.stringify(opts.existing[opts.seoGroup])) as Record<string, unknown>)
      : {};

  const previousCanonical = readCanonicalFromSeo(
    existingSeo,
    opts.pageUrlField,
    opts.canonicalField
  );

  const existingPageUrl = existingSeo[opts.pageUrlField];
  if (
    existingPageUrl &&
    typeof existingPageUrl === "object" &&
    !Array.isArray(existingPageUrl)
  ) {
    const pageUrlObj = { ...(existingPageUrl as Record<string, unknown>) };
    // Only touch canonical — leave url_list and other nested fields unchanged.
    pageUrlObj[opts.canonicalField] = opts.updatedPath;
    existingSeo[opts.pageUrlField] = pageUrlObj;
  } else if (typeof existingPageUrl === "string") {
    // Rare string shape: treat page_url itself as the canonical path.
    existingSeo[opts.pageUrlField] = opts.updatedPath;
  } else {
    // No page_url yet — create the stack shape, then still only rely on canonical.
    const built = buildSeoPageUrlValue(opts.seoFields, opts.updatedPath);
    if (built && typeof built === "object" && !Array.isArray(built)) {
      existingSeo[opts.pageUrlField] = {
        ...(built as Record<string, unknown>),
        [opts.canonicalField]: opts.updatedPath,
      };
    } else {
      existingSeo[opts.pageUrlField] = built;
    }
  }

  return {
    title,
    url: opts.updatedPath,
    seo: existingSeo,
    previousUrl,
    previousCanonical,
  };
}

function selectRows(
  allRows: EntryUrlUpdateRow[],
  mode: "all" | "single" | "ids",
  uids: string[]
): { work: { row: EntryUrlUpdateRow; index: number }[]; error?: string } {
  if (mode === "all") {
    return {
      work: allRows.map((row, index) => ({ row, index })),
    };
  }

  if (uids.length === 0) {
    return {
      work: [],
      error:
        mode === "single"
          ? "mode=single requires --uid=<contentstack_entry_uid>"
          : "mode=ids requires --uids=uid1,uid2 (or --uid=...)",
    };
  }

  if (mode === "single" && uids.length > 1) {
    return {
      work: [],
      error: `mode=single accepts exactly one --uid (got ${uids.length}). Use --mode=ids for multiple.`,
    };
  }

  const wanted = new Set(uids);
  const work = allRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => wanted.has(row.uid));

  const found = new Set(work.map((w) => w.row.uid));
  const missing = uids.filter((u) => !found.has(u));
  if (missing.length > 0) {
    return {
      work: [],
      error: `No sheet row(s) found for uid(s): ${missing.join(", ")}`,
    };
  }

  return { work };
}

export async function runUpdateEntryUrls(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const workbookPath = defaultEntryUrlUpdateWorkbookPath(
    stringArg(argv, "--workbook") ?? stringArg(argv, "--sheet")
  );
  const defaultContentType = resolveDefaultContentTypeUid(argv);
  const defaultLocale = resolveDefaultLocale(argv);
  const skipPass = !argv.includes("--no-skip-pass");
  const concurrency = loadConcurrency(argv);
  const limit = numberArg(argv, "--limit");
  const { mode, uids } = resolveSelection(argv);

  const { urlField, seoGroup, pageUrlField, canonicalField, seoFields } =
    loadUrlUpdateFieldUids();
  const paths = loadPipelinePaths();
  const cfg = loadConfig();
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });

  const allRows = readEntryUrlUpdateWorkbook(workbookPath);
  const selected = selectRows(allRows, mode, uids);
  if (selected.error) {
    throw new Error(selected.error);
  }

  let work = selected.work;
  if (limit != null && limit > 0) work = work.slice(0, limit);

  console.error(
    `[update-entry-urls] workbook=${workbookPath} mode=${mode} ` +
      `selected=${work.length}/${allRows.length} ` +
      `defaultContentType=${defaultContentType || "(per-row)"} locale=${defaultLocale} ` +
      `urlField=${urlField} seo=${seoGroup}.${pageUrlField}.${canonicalField} concurrency=${concurrency}`
  );

  if (work.length === 0) {
    console.error("[update-entry-urls] No rows to process.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const persistAllRows = (): Promise<void> => {
    writeChain = writeChain.then(() => {
      writeEntryUrlUpdateWorkbook(workbookPath, allRows);
    });
    return writeChain;
  };

  await mapWithConcurrency(work, concurrency, async ({ row, index }) => {
    const now = new Date().toISOString();

    if (shouldSkipExisting(row, skipPass)) {
      skipped += 1;
      console.error(`[update-entry-urls] skip (already Pass): uid=${row.uid}`);
      return;
    }

    const updatedPath = normalizeMigrationUrlPath(row.updated_url);
    if (!row.uid) {
      row.update_status = "Fail";
      row.update_message = "Missing uid";
      row.updated_at = now;
      failed += 1;
      allRows[index] = row;
      await persistAllRows();
      return;
    }
    if (!updatedPath) {
      row.update_status = "Fail";
      row.update_message = "Missing updated_url";
      row.updated_at = now;
      failed += 1;
      allRows[index] = row;
      await persistAllRows();
      return;
    }

    const contentTypeUid =
      row.content_type_uid.trim() || defaultContentType || paths.contentTypeUid;
    if (!contentTypeUid) {
      row.update_status = "Fail";
      row.update_message =
        "Missing content_type_uid (set column, --content-type, UPDATE_ENTRY_URL_CONTENT_TYPE, or CS_CONTENT_TYPE_BLOG)";
      row.updated_at = now;
      failed += 1;
      allRows[index] = row;
      await persistAllRows();
      return;
    }

    const locale = row.locale.trim() || defaultLocale;
    row.content_type_uid = contentTypeUid;
    row.locale = locale;

    try {
      const existing = await cs.getEntry(contentTypeUid, row.uid, locale);
      const patched = buildEntryUrlUpdatePayload({
        existing,
        updatedPath,
        urlField,
        seoGroup,
        pageUrlField,
        canonicalField,
        seoFields,
      });

      row.previous_url = patched.previousUrl;
      row.previous_canonical = patched.previousCanonical;
      row.title = patched.title;

      // Only send title (required by CMA helper), url, and seo (merge of existing with canonical only).
      await cs.updateEntry(
        contentTypeUid,
        row.uid,
        {
          title: patched.title,
          [urlField]: patched.url,
          [seoGroup]: patched.seo,
        },
        locale
      );

      row.url = patched.url;
      row.seo_page_url_canonical = updatedPath;
      row.updated_url = updatedPath;
      row.update_status = "Pass";
      row.update_message = `Updated ${urlField} and ${seoGroup}.${pageUrlField}.${canonicalField} only`;
      row.updated_at = now;
      updated += 1;

      console.error(
        `[update-entry-urls] Pass uid=${row.uid} ` +
          `${patched.previousUrl || "(none)"} → ${updatedPath}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      row.update_status = "Fail";
      row.update_message = msg;
      row.updated_at = now;
      failed += 1;
      console.error(`[update-entry-urls] FAIL uid=${row.uid}: ${msg.slice(0, 200)}`);
    } finally {
      allRows[index] = row;
      await persistAllRows();
    }
  });

  await persistAllRows();
  console.error(
    `[update-entry-urls] Done. updated=${updated} skipped=${skipped} failed=${failed} workbook=${workbookPath}`
  );
}
