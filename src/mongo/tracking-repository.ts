import { MongoClient, type Collection } from "mongodb";
import type { MongoConfig } from "../config-pipeline.js";

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
};

export function trackingDocId(
  runId: string,
  sourceSheet: string,
  rowKind: string,
  wpId: number,
  url?: string
): string {
  if (wpId > 0) return `${runId}:${sourceSheet}:${rowKind}:${wpId}`;
  const safe = (url ?? "").replace(/\s+/g, " ").slice(0, 240);
  return `${runId}:${sourceSheet}:${rowKind}:noid:${safe}`;
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
