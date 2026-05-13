import { loadConfig } from "../config.js";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { MappingStore } from "../mapping-store.js";
import { basicAuthHeader, WordPressClient } from "../wordpress/client.js";
import { ensureAssetFolderUid, migrateOneMediaRow } from "./migrate-media-core.js";
import { readMediaSheet, saveMediaSheet, toSheetRow, writeMediaSheet } from "./sheet.js";
import type { MediaSheetRow, WpMediaItem } from "./types.js";
import { numberArg, stringArg } from "./utils.js";
import { readIdsFromXml } from "./xml.js";

type MigrationSelectionMode = "all" | "single" | "ids" | "failed" | "xml";

type MigrationArgs = {
  sheetPath: string;
  mode: MigrationSelectionMode;
  singleId?: number;
  ids: number[];
  offset: number;
  limit: number;
  xmlPath?: string;
};

function parseIdsCsv(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0))];
}

function parseMigrationArgs(argv: string[]): MigrationArgs {
  const sheetPath = stringArg(argv, "--sheet") ?? process.env.MEDIA_SHEET_PATH ?? "wp-media-mapping.xlsx";
  const mode = (stringArg(argv, "--mode") ??
    process.env.MEDIA_MIGRATION_MODE ??
    "all") as MigrationSelectionMode;
  const singleId = numberArg(argv, "--single-id");
  const ids = parseIdsCsv(stringArg(argv, "--ids") ?? process.env.MEDIA_IDS);
  const offset = numberArg(argv, "--offset") ?? (Number(process.env.MEDIA_OFFSET ?? "0") || 0);
  const limit =
    numberArg(argv, "--limit") ??
    (Number(process.env.MEDIA_LIMIT ?? process.env.MEDIA_BATCH_SIZE ?? "25") || 25);
  const xmlPath = stringArg(argv, "--xml-path") ?? process.env.MEDIA_IDS_XML_PATH;
  return { sheetPath, mode, singleId, ids, offset: Math.max(0, offset), limit: Math.max(1, limit), xmlPath };
}

function parseBaseClients() {
  const cfg = loadConfig();
  const auth =
    cfg.wp.user && cfg.wp.applicationPassword
      ? basicAuthHeader(cfg.wp.user, cfg.wp.applicationPassword)
      : undefined;
  const wp = new WordPressClient(cfg.wp.baseUrl, auth);
  const cs = new ContentstackManagementClient({
    apiKey: cfg.contentstack.stackApiKey,
    managementToken: cfg.contentstack.managementToken,
    host: cfg.contentstack.apiHost,
  });
  return { cfg, wp, cs };
}

export async function extractMediaToSheet(argv: string[]): Promise<void> {
  const { wp } = parseBaseClients();
  const sheetPath = stringArg(argv, "--sheet") ?? process.env.MEDIA_SHEET_PATH ?? "wp-media-mapping.xlsx";
  const endpoint = stringArg(argv, "--wp-media-path") ?? process.env.WP_MEDIA_ENDPOINT ?? "/wp-json/wp/v2/media";
  const perPage = "100";
  const out: WpMediaItem[] = [];
  let page = 1;

  while (true) {
    const { items, totalPages } = await wp.getCollectionPage<WpMediaItem>(endpoint, {
      orderby: "id",
      order: "asc",
      per_page: perPage,
      page: String(page),
    });
    out.push(...items);
    if (page >= totalPages) break;
    page += 1;
  }

  const rows = out.map(toSheetRow);
  writeMediaSheet(sheetPath, rows);
  console.error(`Extracted ${rows.length} media items to ${sheetPath}`);
}

function targetRowsByMode(rows: MediaSheetRow[], args: MigrationArgs): MediaSheetRow[] {
  let selected: MediaSheetRow[];
  if (args.mode === "single") {
    if (!args.singleId) throw new Error("single mode requires --single-id=<wp_id>");
    selected = rows.filter((r) => r.wp_id === args.singleId);
  } else if (args.mode === "ids") {
    if (args.ids.length === 0) throw new Error("ids mode requires --ids=1,2,3");
    const set = new Set(args.ids);
    selected = rows.filter((r) => set.has(r.wp_id));
  } else if (args.mode === "failed") {
    selected = rows.filter((r) => r.migration_status === "Fail");
  } else if (args.mode === "xml") {
    if (!args.ids.length) throw new Error("xml mode requires XML IDs (pass --xml-path or MEDIA_IDS_XML_PATH)");
    const set = new Set(args.ids);
    selected = rows.filter((r) => set.has(r.wp_id));
  } else {
    selected = rows;
  }
  return selected.slice(args.offset, args.offset + args.limit);
}

export async function migrateFromSheet(argv: string[]): Promise<void> {
  const { cfg, wp, cs } = parseBaseClients();
  const args = parseMigrationArgs(argv);
  if (args.mode === "xml") {
    if (!args.xmlPath) throw new Error("xml mode requires --xml-path=/path/file.xml");
    args.ids = await readIdsFromXml(args.xmlPath);
  }
  const rows = readMediaSheet(args.sheetPath);
  const selectedRows = targetRowsByMode(rows, args);
  if (selectedRows.length === 0) {
    console.error("No rows selected for migration.");
    return;
  }

  const map = await MappingStore.load(cfg.mappingFile);
  const locale = process.env.CONTENTSTACK_LOCALE;
  const folderUid = await ensureAssetFolderUid(map, cs);
  let completed = 0;

  for (const row of selectedRows) {
    const rowRef = rows.find((r) => r.wp_id === row.wp_id);
    if (!rowRef) continue;
    try {
      const result = await migrateOneMediaRow(rowRef, wp, cs, map, folderUid, locale);
      rowRef.migration_status = "Pass";
      rowRef.contentstack_uid = result.uid;
      rowRef.contentstack_type = result.type;
      rowRef.migration_message = "";
      rowRef.migrated_at = new Date().toISOString();
      completed += 1;
    } catch (error) {
      rowRef.migration_status = "Fail";
      rowRef.migration_message = error instanceof Error ? error.message.slice(0, 800) : String(error);
      rowRef.migrated_at = new Date().toISOString();
    }
    saveMediaSheet(args.sheetPath, rows);
    await map.save();
  }

  console.error(`Media migration complete. ${completed}/${selectedRows.length} rows passed.`);
}
