import { loadConfig } from "../config.js";
import { loadPipelinePaths } from "../config-pipeline.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { closeMongo } from "../mongo/tracking-repository.js";
import { initPipelineEnv, numberArg, stringArg } from "./args.js";
import { loadAllTracking } from "./tracking-sync.js";
import type { TrackingRow } from "./types.js";

const RELEASE_ITEMS_BATCH_SIZE = 25;

function loadReleaseName(argv: string[]): string {
  const name =
    stringArg(argv, "--release-name")?.trim() ||
    process.env.CONTENTSTACK_RELEASE_NAME?.trim() ||
    process.env.RELEASE_NAME?.trim();
  if (!name) {
    throw new Error(
      "Set CONTENTSTACK_RELEASE_NAME (or RELEASE_NAME) or pass --release-name=My Release"
    );
  }
  return name;
}

function parseReleaseAction(raw: string | undefined): "publish" | "unpublish" {
  const v = (raw ?? "publish").trim().toLowerCase();
  if (v === "unpublish") return "unpublish";
  return "publish";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function releaseItemKey(uid: string, locale: string, contentTypeUid: string): string {
  return `${uid}|${locale.toLowerCase()}|${contentTypeUid}`;
}

export async function runAddToReleaseFromTracking(argv: string[]): Promise<void> {
  initPipelineEnv(argv);
  const paths = loadPipelinePaths();
  const cfg = loadConfig();
  const locale =
    process.env.CONTENTSTACK_LOCALE?.trim() ||
    paths.publishLocales[0] ||
    "en-us";

  const releaseName = loadReleaseName(argv);
  const createIfMissing = process.env.CONTENTSTACK_RELEASE_CREATE !== "0";
  const action = parseReleaseAction(
    stringArg(argv, "--release-action") ?? process.env.CONTENTSTACK_RELEASE_ACTION
  );
  const migrationStatusFilter =
    stringArg(argv, "--filter-migration-status") ??
    process.env.RELEASE_FILTER_MIGRATION_STATUS ??
    "Pass";
  const updateToLatest = process.env.CONTENTSTACK_RELEASE_UPDATE_TO_LATEST !== "0";
  const skipExisting = process.env.CONTENTSTACK_RELEASE_SKIP_EXISTING !== "0";
  const limit =
    numberArg(argv, "--limit") ?? (Number(process.env.RELEASE_LIMIT ?? "5000") || 5000);

  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });

  const all = loadAllTracking(paths);
  let targets: TrackingRow[] = all.filter(
    (r) =>
      r.row_kind === "content" &&
      r.migration_status === migrationStatusFilter &&
      Boolean(r.contentstack_entry_uid?.trim())
  );
  targets = targets.slice(0, Math.max(1, limit));

  if (targets.length === 0) {
    console.error(
      `[release] No tracking rows matched (migration_status=${migrationStatusFilter}, has entry uid).`
    );
    await closeMongo();
    return;
  }

  console.error(
    `[release] Ensuring release "${releaseName}" (createIfMissing=${createIfMissing})…`
  );
  const releaseUid = await cs.ensureRelease(releaseName, createIfMissing);
  console.error(`[release] Using release uid=${releaseUid} name="${releaseName}"`);

  const existingInRelease = skipExisting ? await cs.listReleaseItems(releaseUid) : [];
  const existingKeys = new Set(
    existingInRelease.map((i) => releaseItemKey(i.uid, i.locale, i.content_type_uid))
  );
  if (skipExisting && existingKeys.size > 0) {
    console.error(`[release] ${existingKeys.size} item(s) already in release; duplicates will be skipped.`);
  }

  type PendingItem = {
    row: TrackingRow;
    contentTypeUid: string;
    entryUid: string;
    version: number;
  };

  const pending: PendingItem[] = [];
  for (const row of targets) {
    const ctUid = row.content_type_uid?.trim() || paths.contentTypeUid;
    const entryUid = row.contentstack_entry_uid?.trim();
    if (!ctUid || !entryUid) continue;
    try {
      const entry = await cs.getEntry(ctUid, entryUid, locale);
      const version = typeof entry.version === "number" ? entry.version : 1;
      pending.push({ row, contentTypeUid: ctUid, entryUid, version });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 400) : String(e);
      console.error(`[release] wp_id=${row.wp_id} uid=${entryUid} skip (GET entry): ${msg}`);
    }
  }

  if (pending.length === 0) {
    console.error("[release] No entries could be resolved for the release.");
    await closeMongo();
    return;
  }

  const toAdd = skipExisting
    ? pending.filter(
        (p) => !existingKeys.has(releaseItemKey(p.entryUid, locale, p.contentTypeUid))
      )
    : pending;
  const skipped = pending.length - toAdd.length;
  if (skipped > 0) {
    console.error(`[release] Skipping ${skipped} entry/entries already in release.`);
  }
  if (toAdd.length === 0) {
    console.error("[release] All matched entries are already in the release.");
    if (updateToLatest) {
      try {
        await cs.updateReleaseItemsToLatest(releaseUid);
        console.error("[release] Updated all release items to their latest versions.");
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 400) : String(e);
        console.error(`[release] update_items warning: ${msg}`);
      }
    }
    await closeMongo();
    return;
  }

  let added = 0;
  const batches = chunk(toAdd, RELEASE_ITEMS_BATCH_SIZE);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    try {
      await cs.addItemsToRelease(
        releaseUid,
        batch.map((p) => ({
          uid: p.entryUid,
          version: p.version,
          locale,
          content_type_uid: p.contentTypeUid,
          action,
        }))
      );
      added += batch.length;
      console.error(
        `[release] Batch ${i + 1}/${batches.length}: added ${batch.length} item(s) (total ${added}/${toAdd.length})`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 800) : String(e);
      console.error(`[release] Batch ${i + 1}/${batches.length} FAIL: ${msg}`);
      for (const p of batch) {
        console.error(
          `[release]   wp_id=${p.row.wp_id} ct=${p.contentTypeUid} uid=${p.entryUid} v=${p.version}`
        );
      }
    }
  }

  if (updateToLatest && (added > 0 || skipped > 0)) {
    try {
      await cs.updateReleaseItemsToLatest(releaseUid);
      console.error("[release] Updated all release items to their latest versions.");
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 400) : String(e);
      console.error(`[release] update_items warning: ${msg}`);
    }
  }

  await closeMongo();
  console.error(
    `[release] Completed: ${added} added, ${skipped} already in release, ${pending.length} matched from tracking (action=${action}).`
  );
}
