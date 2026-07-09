import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { ContentstackManagementClient } from "../contentstack/client.js";
import { initPipelineEnv, stringArg } from "./args.js";
import { mapWithConcurrency } from "./async-pool.js";
import { ContentstackAssetFolderTree } from "./contentstack-asset-folders.js";
import {
  defaultFolderImagesWorkbookPath,
  readFolderImagesWorkbook,
  upsertFolderImageRow,
  writeFolderImagesWorkbook,
  type FolderImageUploadRow,
} from "./folder-images-sheet.js";
import { prepareImageUploadBuffer } from "./image-compress.js";
import { formatFileSizeBytes } from "./image-size-limit.js";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
]);

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
};

function loadContentstackClient(): ContentstackManagementClient {
  const managementToken = process.env.CONTENTSTACK_MANAGEMENT_TOKEN?.trim();
  const apiKey = process.env.CONTENTSTACK_STACK_API_KEY?.trim();
  const host = process.env.CONTENTSTACK_API_HOST?.trim() || "api.contentstack.io";
  if (!managementToken || !apiKey) {
    throw new Error("Missing CONTENTSTACK_MANAGEMENT_TOKEN or CONTENTSTACK_STACK_API_KEY");
  }
  return new ContentstackManagementClient({
    apiKey,
    managementToken,
    host,
  });
}

function loadCsParentFolderUid(): string {
  const uid = process.env.CS_ASSET_FOLDER_UID?.trim();
  if (!uid) {
    throw new Error(
      "Set CS_ASSET_FOLDER_UID to the Contentstack asset parent folder for uploads"
    );
  }
  return uid;
}

function loadLocalRootFolder(argv: string[]): string {
  const fromArg = stringArg(argv, "--folder")?.trim();
  const fromEnv = process.env.FOLDER_IMAGES_LOCAL_PATH?.trim();
  const raw = fromArg || fromEnv;
  if (!raw) {
    throw new Error(
      "Provide local parent folder via --folder=<path> or FOLDER_IMAGES_LOCAL_PATH"
    );
  }
  return resolve(raw);
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i <= 0) return "";
  return filename.slice(i).toLowerCase();
}

function mimeFromFilename(filename: string): string {
  const ext = extensionOf(filename);
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

function isImageFilename(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filename));
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(rootDir);
  return out.sort((a, b) => a.localeCompare(b));
}

async function collectLocalImageFiles(localRoot: string): Promise<
  { absolutePath: string; relativePath: string; filename: string }[]
> {
  const files = await walkFiles(localRoot);
  return files
    .filter((absolutePath) => isImageFilename(basename(absolutePath)))
    .map((absolutePath) => {
      const relativePath = relative(localRoot, absolutePath).replace(/\\/g, "/");
      return { absolutePath, relativePath, filename: basename(absolutePath) };
    });
}

function loadConcurrency(argv: string[]): number {
  const raw = stringArg(argv, "--concurrency") ?? process.env.FOLDER_IMAGES_CONCURRENCY ?? "4";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 16) : 4;
}

function shouldSkipExisting(row: FolderImageUploadRow | undefined, skipPass: boolean): boolean {
  return Boolean(skipPass && row?.upload_status === "Pass" && row.contentstack_asset_uid);
}

export async function runUploadFolderImages(argv: string[]): Promise<void> {
  initPipelineEnv(argv);

  const localRoot = loadLocalRootFolder(argv);
  const csParentUid = loadCsParentFolderUid();
  const workbookPath = defaultFolderImagesWorkbookPath();
  const skipPass = !argv.includes("--no-skip-pass");
  const concurrency = loadConcurrency(argv);

  const cs = loadContentstackClient();
  const folderTree = new ContentstackAssetFolderTree(cs);

  const rootStat = await stat(localRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Local folder is not a directory: ${localRoot}`);
  }

  try {
    await cs.getAssetSubfolders(csParentUid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `CS_ASSET_FOLDER_UID="${csParentUid}" is not a valid Contentstack asset folder. ` +
        `Open Contentstack → Assets, select the target folder, and copy its folder UID from the URL or folder details. ${msg}`
    );
  }

  let sheetRows = readFolderImagesWorkbook(workbookPath);
  const byRelative = new Map(
    sheetRows.map((r) => [r.relative_path.replace(/\\/g, "/"), r] as const)
  );

  const files = await collectLocalImageFiles(localRoot);
  console.error(
    `[folder-images] localRoot=${localRoot} csParentUid=${csParentUid} ` +
      `images=${files.length} workbook=${workbookPath} concurrency=${concurrency}`
  );

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  await mapWithConcurrency(files, concurrency, async (file) => {
    const relKey = file.relativePath.replace(/\\/g, "/");
    const existing = byRelative.get(relKey);
    if (shouldSkipExisting(existing, skipPass)) {
      skipped += 1;
      console.error(`[folder-images] skip (already Pass): ${relKey}`);
      return;
    }

    const now = new Date().toISOString();
    let row: FolderImageUploadRow = {
      local_path: file.absolutePath,
      relative_path: relKey,
      filename: file.filename,
      file_size_bytes: 0,
      mime_type: mimeFromFilename(file.filename),
      contentstack_folder_uid: "",
      contentstack_folder_path: "",
      contentstack_asset_uid: "",
      compressed: "No",
      original_size: "",
      output_size: "",
      upload_status: "Fail",
      upload_message: "",
      uploaded_at: now,
    };

    try {
      const fileStat = await stat(file.absolutePath);
      row.file_size_bytes = fileStat.size;
      row.original_size = formatFileSizeBytes(fileStat.size);

      if (!isImageFilename(file.filename)) {
        row.upload_status = "Skipped";
        row.upload_message = "Not an image file";
        skipped += 1;
        return;
      }

      const buffer = await readFile(file.absolutePath);
      const contentType = mimeFromFilename(file.filename);
      const prepared = await prepareImageUploadBuffer({
        buffer,
        contentType,
        filename: file.filename,
      });

      row.compressed = prepared.compressed ? "Yes" : "No";
      row.output_size = formatFileSizeBytes(prepared.outputBytes);
      if (prepared.warning) {
        row.upload_message = prepared.warning;
      }

      const { folderUid, folderPath } = await folderTree.ensureFolderPath(relKey, csParentUid);
      row.contentstack_folder_uid = folderUid;
      row.contentstack_folder_path = folderPath;

      const uploadedAsset = await cs.uploadAssetFile({
        buffer: prepared.buffer,
        filename: prepared.filename,
        contentType: prepared.contentType,
        title: file.filename,
        parentFolderUid: folderUid,
      });

      row.contentstack_asset_uid = uploadedAsset.uid;
      row.upload_status = "Pass";
      row.upload_message = prepared.warning
        ? prepared.warning
        : prepared.compressed
          ? `Uploaded (compressed ${row.original_size} → ${row.output_size})`
          : "Uploaded";
      row.mime_type = prepared.contentType;
      uploaded += 1;

      console.error(
        `[folder-images] Pass uid=${uploadedAsset.uid} folder=${folderPath || "/"} ` +
          `${relKey} ${row.original_size}${prepared.compressed ? ` → ${row.output_size}` : ""}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      row.upload_status = "Fail";
      row.upload_message = msg;
      failed += 1;
      console.error(`[folder-images] FAIL ${relKey}: ${msg.slice(0, 200)}`);
    } finally {
      sheetRows = upsertFolderImageRow(sheetRows, row);
      byRelative.set(relKey, row);
      writeFolderImagesWorkbook(workbookPath, sheetRows);
    }
  });

  console.error(
    `[folder-images] Done. uploaded=${uploaded} skipped=${skipped} failed=${failed} ` +
      `workbook=${workbookPath}`
  );
}
