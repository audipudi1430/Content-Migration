import type { ContentstackManagementClient } from "../contentstack/client.js";

type FolderRecord = { uid: string; name: string; parent_uid?: string };

/** Resolve or create Contentstack asset folders mirroring a relative path. */
export class ContentstackAssetFolderTree {
  private readonly folderByParentAndName = new Map<string, string>();
  private allFolders: FolderRecord[] | undefined;

  constructor(private readonly cs: ContentstackManagementClient) {}

  private cacheKey(parentUid: string, name: string): string {
    return `${parentUid}|${name}`;
  }

  private async loadFolders(): Promise<FolderRecord[]> {
    if (!this.allFolders) {
      this.allFolders = await this.cs.getAssetFolders();
      for (const f of this.allFolders) {
        const parent = f.parent_uid ?? "";
        this.folderByParentAndName.set(this.cacheKey(parent, f.name), f.uid);
      }
    }
    return this.allFolders;
  }

  async ensureFolder(name: string, parentUid: string): Promise<string> {
    const folderName = name.trim();
    if (!folderName) throw new Error("Asset folder name is empty");

    const key = this.cacheKey(parentUid, folderName);
    const cached = this.folderByParentAndName.get(key);
    if (cached) return cached;

    await this.loadFolders();
    const existing = this.allFolders!.find(
      (f) => f.name === folderName && (f.parent_uid ?? "") === parentUid
    );
    if (existing) {
      this.folderByParentAndName.set(key, existing.uid);
      return existing.uid;
    }

    const created = await this.cs.createAssetFolder(folderName, parentUid);
    this.folderByParentAndName.set(key, created.uid);
    this.allFolders!.push({ uid: created.uid, name: folderName, parent_uid: parentUid });
    return created.uid;
  }

  /**
   * Ensure nested folders under `rootParentUid` for a relative path like `events/2024/photo.jpg`.
   * Returns the UID of the folder that should contain the file.
   */
  async ensureFolderPath(relativePath: string, rootParentUid: string): Promise<{
    folderUid: string;
    folderPath: string;
  }> {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 1) {
      return { folderUid: rootParentUid, folderPath: "/" };
    }

    const dirParts = parts.slice(0, -1);
    let parentUid = rootParentUid;
    const pathSegments: string[] = [];

    for (const segment of dirParts) {
      parentUid = await this.ensureFolder(segment, parentUid);
      pathSegments.push(segment);
    }

    return {
      folderUid: parentUid,
      folderPath: `/${pathSegments.join("/")}`,
    };
  }
}
