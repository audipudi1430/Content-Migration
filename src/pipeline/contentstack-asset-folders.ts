import type { ContentstackManagementClient } from "../contentstack/client.js";

/** Resolve or create Contentstack asset folders mirroring a relative path. */
export class ContentstackAssetFolderTree {
  private readonly folderByParentAndName = new Map<string, string>();

  constructor(private readonly cs: ContentstackManagementClient) {}

  private cacheKey(parentUid: string, name: string): string {
    return `${parentUid}|${name}`;
  }

  async ensureFolder(name: string, parentUid: string): Promise<string> {
    const folderName = name.trim();
    if (!folderName) throw new Error("Asset folder name is empty");

    const key = this.cacheKey(parentUid, folderName);
    const cached = this.folderByParentAndName.get(key);
    if (cached) return cached;

    const existing = await this.cs.findAssetFolderByName(folderName, parentUid);
    if (existing) {
      this.folderByParentAndName.set(key, existing.uid);
      return existing.uid;
    }

    try {
      const created = await this.cs.createAssetFolder(folderName, parentUid);
      this.folderByParentAndName.set(key, created.uid);
      return created.uid;
    } catch (e) {
      const again = await this.cs.findAssetFolderByName(folderName, parentUid);
      if (again) {
        this.folderByParentAndName.set(key, again.uid);
        return again.uid;
      }
      throw e;
    }
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
