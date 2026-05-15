import { MongoClient, type Collection } from "mongodb";
import { createHash } from "node:crypto";
import type { MongoConfig } from "../config-pipeline.js";

const MAX_URL_IN_MERGE_KEY = 400;

/**
 * Stable key for the same logical source row (sheet + kind + URL).
 * URL is normalized; very long URLs are hashed so Excel/Mongo keys stay bounded.
 * When the sheet has no URL, falls back to `id:{wp_id}` or `noid`.
 */
export function trackingRowStableMergeKey(
  sourceSheet: string,
  rowKind: string,
  wpId: number,
  url: string
): string {
  let u = url.trim().replace(/\/+$/g, "").replace(/\s+/g, " ");
  if (u.length > MAX_URL_IN_MERGE_KEY) {
    u = `h:${createHash("sha256").update(u).digest("hex").slice(0, 40)}`;
  }
  if (u.length > 0) return `${sourceSheet}|${rowKind}|${u}`;
  if (wpId > 0) return `${sourceSheet}|${rowKind}|id:${wpId}`;
  return `${sourceSheet}|${rowKind}|noid`;
}

export type MigrationTrackingDoc = {
  /** Stable document id for upserts */
  _id: string;
  runId: string;
  envLabel: string;
  sourceSheet: string;
  rowKind: "content" | "media";
  url: string;
  wpId: number;
  wpRestPath: string;
  contentTypeUid?: string;
  featuredMediaWpId?: number;
  migrationStatus: string;
  publishStatus: string;
  contentstackEntryUid?: string;
  contentstackAssetUid?: string;
  migrationMessage?: string;
  publishedAt?: string;
  updatedAt: string;
  /** JSON snapshot of source workbook columns at extract. */
  sourceColumnsJson?: string;
  extractedAt?: string;
  /** Contentstack CMA URL for the entry or asset after successful migration. */
  targetUrl?: string;
  wpSlug?: string;
  wpTitle?: string;
  wpStatus?: string;
  wpType?: string;
  wpLink?: string;
  /** WordPress REST snapshot (extract enrich). */
  wpExtractJson?: string;
};

export function trackingDocId(
  runId: string,
  sourceSheet: string,
  rowKind: string,
  wpId: number,
  url?: string
): string {
  return `${runId}:${trackingRowStableMergeKey(sourceSheet, rowKind, wpId, url ?? "")}`;
}

let sharedClient: MongoClient | undefined;

export async function getTrackingCollection(
  cfg: MongoConfig
): Promise<Collection<MigrationTrackingDoc> | null> {
  if (!cfg.enabled || !cfg.uri) return null;
  if (!sharedClient) {
    sharedClient = new MongoClient(cfg.uri);
    await sharedClient.connect();
  }
  const db = cfg.dbName ? sharedClient.db(cfg.dbName) : sharedClient.db();
  return db.collection<MigrationTrackingDoc>(cfg.collection);
}

export async function upsertTrackingDoc(
  coll: Collection<MigrationTrackingDoc> | null,
  doc: MigrationTrackingDoc
): Promise<void> {
  if (!coll) return;
  await coll.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function closeMongo(): Promise<void> {
  if (sharedClient) {
    await sharedClient.close();
    sharedClient = undefined;
  }
}
