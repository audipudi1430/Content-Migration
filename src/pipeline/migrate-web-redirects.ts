import { loadConfig } from "../config.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import {
  initPipelineEnv,
  parseSelection,
  parseUpdateFlag,
  stringArg,
  type SelectionMode,
} from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import {
  defaultWebRedirectWorkbookPath,
  isWebRedirectPending,
  mergeWebRedirectPriorTracking,
  readWebRedirectWorkbook,
  resolveWebRedirectTabName,
  webRedirectTrackingWorkbookPath,
  writeWebRedirectStatusIntoSourceWorkbook,
  writeWebRedirectTrackingWorkbook,
  type WebRedirectRow,
} from "./migrate-web-redirects-sheet.js";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const DEFAULT_CONTENT_TYPE = "webredirects";

function loadConcurrency(argv: string[]): number {
  const raw =
    stringArg(argv, "--concurrency") ??
    process.env.WEB_REDIRECT_CONCURRENCY ??
    String(DEFAULT_CONCURRENCY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), MAX_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
}

function loadContentTypeUid(argv: string[]): string {
  return (
    stringArg(argv, "--content-type")?.trim() ||
    process.env.WEB_REDIRECT_CONTENT_TYPE?.trim() ||
    process.env.CS_CONTENT_TYPE_WEB_REDIRECTS?.trim() ||
    DEFAULT_CONTENT_TYPE
  );
}

function loadFieldUids(): {
  redirectCondition: string;
  redirectMapping: string;
  status: string;
  statusValue: string;
} {
  return {
    redirectCondition:
      process.env.WEB_REDIRECT_FIELD_CONDITION?.trim() || "redirect_condition",
    redirectMapping:
      process.env.WEB_REDIRECT_FIELD_MAPPING?.trim() || "redirect_mapping",
    status: process.env.WEB_REDIRECT_FIELD_STATUS?.trim() || "status",
    statusValue: process.env.WEB_REDIRECT_STATUS_VALUE?.trim() || "301",
  };
}

/**
 * Same selection shape as story migrate (`selectContentRows`):
 * filter by mode / --update, then slice(offset, offset + limit).
 */
export function selectWebRedirectRows(
  rows: WebRedirectRow[],
  mode: SelectionMode,
  opts: { offset: number; limit: number },
  updateExisting = false
): { row: WebRedirectRow; index: number }[] {
  let selected = rows.map((row, index) => ({ row, index }));

  if (mode === "failed") {
    selected = selected.filter(({ row }) => row.update_status === "Fail");
  } else if (updateExisting) {
    selected = selected.filter(
      ({ row }) =>
        row.update_status === "Pass" ||
        row.update_status === "Pending" ||
        row.update_status === "Fail" ||
        isWebRedirectPending(row)
    );
  } else {
    selected = selected.filter(({ row }) => isWebRedirectPending(row));
  }

  return selected.slice(opts.offset, opts.offset + opts.limit);
}

async function findEntryUidByExactField(
  cs: ContentstackManagementClient,
  contentTypeUid: string,
  fieldUid: string,
  value: string,
  locale: string
): Promise<string[]> {
  return cs.findEntryUidsByExactUrl(contentTypeUid, [value], locale, fieldUid);
}

/**
 * Create/update Contentstack `webredirects` entries from a workbook.
 *
 * Selection matches story migrate: `--mode` + `--offset` + `--limit` (default 25).
 * Pending/Fail only unless `--update` (includes Pass).
 */
export async function runMigrateWebRedirects(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const workbookPath = defaultWebRedirectWorkbookPath(
    stringArg(argv, "--workbook") ?? stringArg(argv, "--sheet-file")
  );
  const tabName = resolveWebRedirectTabName(stringArg(argv, "--tab"));
  const allowUpdatePass = parseUpdateFlag(argv, "WEB_REDIRECT_UPDATE");
  const concurrency = loadConcurrency(argv);
  const sel = parseSelection(argv, "WEB_REDIRECT");
  const mode = (sel.mode || "all") as SelectionMode;
  const locale =
    stringArg(argv, "--locale")?.trim() ||
    process.env.WEB_REDIRECT_LOCALE?.trim() ||
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    "en-us";
  const contentTypeUid = loadContentTypeUid(argv);
  const fields = loadFieldUids();

  const cfg = loadConfig();
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });

  const allRows = readWebRedirectWorkbook(workbookPath, tabName);
  const mergedPrior = mergeWebRedirectPriorTracking(workbookPath, allRows);
  const passCount = allRows.filter((r) => r.update_status === "Pass").length;
  const failCount = allRows.filter((r) => r.update_status === "Fail").length;
  const pendingCount = allRows.filter((r) => isWebRedirectPending(r)).length;

  const selected = selectWebRedirectRows(allRows, mode, sel, allowUpdatePass);
  const workIndexes = selected.map((s) => s.index);

  console.error(
    `[web-redirects] workbook=${workbookPath} tab=${tabName} mode=${mode} ` +
      `rows=${allRows.length} pass=${passCount} fail=${failCount} pending=${pendingCount} ` +
      `selected=${workIndexes.length} offset=${sel.offset} limit=${sel.limit} ` +
      `concurrency=${concurrency} update=${allowUpdatePass ? 1 : 0} ` +
      `mergedTracking=${mergedPrior} contentType=${contentTypeUid} locale=${locale}`
  );

  if (workIndexes.length === 0) {
    console.error(
      "[web-redirects] No rows selected (Pass skipped unless --update; try --mode=failed or adjust --offset/--limit)."
    );
    writeWebRedirectTrackingWorkbook(workbookPath, allRows);
    return;
  }

  if (allowUpdatePass) {
    console.error(
      "[web-redirects] --update: will PUT existing Contentstack entries when UID/redirect_condition is known."
    );
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(() => {
      writeWebRedirectTrackingWorkbook(workbookPath, allRows);
      writeWebRedirectStatusIntoSourceWorkbook(workbookPath, tabName, allRows);
    });
    return writeChain;
  };

  await mapWithConcurrency(workIndexes, concurrency, async (rowIndex) => {
    const row = allRows[rowIndex]!;
    const now = new Date().toISOString();

    if (row.update_status === "Pass" && !allowUpdatePass) {
      skipped += 1;
      return;
    }

    const title = row.title.trim();
    const condition = row.url.trim();
    const mapping = row.new_url.trim();

    if (!title) {
      row.update_status = "Fail";
      row.update_message = "Missing title";
      row.updated_at = now;
      failed += 1;
      allRows[rowIndex] = row;
      await persist();
      return;
    }
    if (!condition) {
      row.update_status = "Fail";
      row.update_message = "Missing url (redirect_condition)";
      row.updated_at = now;
      failed += 1;
      allRows[rowIndex] = row;
      await persist();
      return;
    }
    if (!mapping) {
      row.update_status = "Fail";
      row.update_message = "Missing new_url (redirect_mapping)";
      row.updated_at = now;
      failed += 1;
      allRows[rowIndex] = row;
      await persist();
      return;
    }

    const payload = {
      title,
      [fields.redirectCondition]: condition,
      [fields.redirectMapping]: mapping,
      [fields.status]: fields.statusValue,
    };

    let entryUid = row.contentstack_entry_uid.trim();
    try {
      if (!entryUid) {
        const matches = await findEntryUidByExactField(
          cs,
          contentTypeUid,
          fields.redirectCondition,
          condition,
          locale
        );
        if (matches.length > 0) {
          entryUid = matches[0]!;
          if (matches.length > 1) {
            console.error(
              `[web-redirects] WARNING: ${matches.length} entries matched ${fields.redirectCondition}=${condition}; using ${entryUid}`
            );
          }
        }
      }

      if (entryUid) {
        // Already in Contentstack: skip rewrite unless --update or prior Fail retry.
        if (!allowUpdatePass && row.update_status !== "Fail") {
          row.contentstack_entry_uid = entryUid;
          row.update_status = "Pass";
          row.update_message = `Already exists uid=${entryUid}; skipped (use --update to rewrite)`;
          row.updated_at = now;
          skipped += 1;
          allRows[rowIndex] = row;
          await persist();
          console.error(
            `[web-redirects] Pass (skip existing) uid=${entryUid} title=${title}`
          );
          return;
        }
        await cs.updateEntry(contentTypeUid, entryUid, payload, locale);
        row.contentstack_entry_uid = entryUid;
        row.update_status = "Pass";
        row.update_message = `Updated uid=${entryUid}`;
        row.updated_at = now;
        updated += 1;
        console.error(
          `[web-redirects] Pass (update) uid=${entryUid} title=${title}`
        );
      } else {
        const createdEntry = await cs.createEntry(contentTypeUid, payload, locale);
        entryUid = createdEntry.uid;
        row.contentstack_entry_uid = entryUid;
        row.update_status = "Pass";
        row.update_message = `Created uid=${entryUid}`;
        row.updated_at = now;
        created += 1;
        console.error(
          `[web-redirects] Pass (create) uid=${entryUid} title=${title}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      if (entryUid) row.contentstack_entry_uid = entryUid;
      row.update_status = "Fail";
      row.update_message = msg;
      row.updated_at = now;
      failed += 1;
      console.error(
        `[web-redirects] FAIL title=${title || "(none)"}: ${msg.slice(0, 220)}`
      );
    } finally {
      allRows[rowIndex] = row;
      await persist();
    }
  });

  await persist();
  console.error(
    `[web-redirects] Done. created=${created} updated=${updated} skipped=${skipped} failed=${failed} ` +
      `tracking=${webRedirectTrackingWorkbookPath(workbookPath)}`
  );
}
