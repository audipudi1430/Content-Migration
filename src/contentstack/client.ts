/**
 * Minimal Contentstack Management API client (v3).
 * @see https://www.contentstack.com/docs/developers/apis/content-management-api
 */
export type CsClientConfig = {
  apiKey: string;
  managementToken: string;
  /** e.g. api.contentstack.io or eu-api.contentstack.io */
  host: string;
};

export class ContentstackManagementClient {
  constructor(private readonly cfg: CsClientConfig) {}

  private base(): string {
    return `https://${this.cfg.host}/v3`;
  }

  private authHeaders(): Record<string, string> {
    return {
      api_key: this.cfg.apiKey,
      authorization: this.cfg.managementToken,
    };
  }

  private headers(): HeadersInit {
    return { ...this.authHeaders(), "Content-Type": "application/json" };
  }

  async createEntry<T extends Record<string, unknown>>(
    contentTypeUid: string,
    entry: { title: string; [key: string]: unknown },
    locale?: string
  ): Promise<{ uid: string; [k: string]: unknown }> {
    const q = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    const url = `${this.base()}/content_types/${encodeURIComponent(contentTypeUid)}/entries${q}`;
    const body = JSON.stringify({ entry });
    const res = await fetch(url, { method: "POST", headers: this.headers(), body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} POST entry: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as { entry: { uid: string } };
    return json.entry as { uid: string };
  }

  /**
   * Create an asset folder. Body shape per CMA docs: `{ "asset": { "name", "parent_uid?" } }`.
   */
  async createAssetFolder(name: string, parentUid?: string): Promise<{ uid: string }> {
    const body: { asset: { name: string; parent_uid?: string } } = {
      asset: { name },
    };
    if (parentUid) body.asset.parent_uid = parentUid;

    const res = await fetch(`${this.base()}/assets/folders`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} POST asset folder: ${text.slice(0, 800)}`);

    const json = JSON.parse(text) as { asset_folder?: { uid: string }; asset?: { uid: string } };
    const uid = json.asset_folder?.uid ?? json.asset?.uid;
    if (!uid) {
      throw new Error(`Contentstack create folder failed, missing uid in response: ${text.slice(0, 800)}`);
    }
    return { uid };
  }

  async getAssetFolder(uid: string): Promise<{ uid: string; name: string; parent_uid?: string }> {
    const res = await fetch(`${this.base()}/assets/${encodeURIComponent(uid)}`, {
      headers: this.headers(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} GET asset ${uid}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as { asset?: { uid: string; name: string; parent_uid?: string } };
    const asset = json.asset;
    if (!asset?.uid) {
      throw new Error(`Contentstack GET asset missing uid: ${text.slice(0, 800)}`);
    }
    return asset;
  }

  /** Returns whether an asset UID exists in this stack (404 → false). */
  async assetExists(uid: string): Promise<boolean> {
    const id = uid?.trim();
    if (!id) return false;
    const res = await fetch(`${this.base()}/assets/${encodeURIComponent(id)}`, {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Contentstack ${res.status} GET asset ${id}: ${text.slice(0, 800)}`);
    }
    return true;
  }

  /** Asset `file_size` in bytes when present on the CMA asset object. */
  async getAssetFileSizeBytes(uid: string): Promise<number | undefined> {
    const id = uid?.trim();
    if (!id) return undefined;
    const res = await fetch(`${this.base()}/assets/${encodeURIComponent(id)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { asset?: { file_size?: unknown } };
      const raw = json.asset?.file_size;
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
      if (typeof raw === "string") {
        const n = Number(raw.trim());
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Fetch subfolders of a parent asset folder (CMA: GET /assets?folder=…&include_folders=true). */
  async getAssetSubfolders(
    parentFolderUid: string
  ): Promise<{ uid: string; name: string; parent_uid?: string }[]> {
    const folders: { uid: string; name: string; parent_uid?: string }[] = [];
    let skip = 0;
    const limit = 100;
    while (true) {
      const params = new URLSearchParams({
        folder: parentFolderUid,
        include_folders: "true",
        query: JSON.stringify({ is_dir: true }),
        limit: String(limit),
        skip: String(skip),
      });
      const url = `${this.base()}/assets?${params}`;
      const res = await fetch(url, { headers: this.headers() });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Contentstack ${res.status} GET asset subfolders: ${text.slice(0, 800)}`);
      }
      const json = JSON.parse(text) as {
        assets?: { uid: string; name: string; parent_uid?: string; is_dir?: boolean }[];
      };
      const items = (json.assets ?? []).filter((a) => a.is_dir !== false && a.uid && a.name);
      folders.push(
        ...items.map((a) => ({ uid: a.uid, name: a.name, parent_uid: a.parent_uid }))
      );
      if (items.length < limit) break;
      skip += limit;
    }
    return folders;
  }

  /** Find a child folder by exact name under a parent folder. */
  async findAssetFolderByName(
    name: string,
    parentFolderUid: string
  ): Promise<{ uid: string; name: string; parent_uid?: string } | undefined> {
    const folderName = name.trim();
    if (!folderName) return undefined;

    const params = new URLSearchParams({
      folder: parentFolderUid,
      include_folders: "true",
      query: JSON.stringify({ is_dir: true, name: folderName }),
      limit: "10",
    });
    const url = `${this.base()}/assets?${params}`;
    const res = await fetch(url, { headers: this.headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} GET asset folder by name: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as {
      assets?: { uid: string; name: string; parent_uid?: string; is_dir?: boolean }[];
    };
    return (json.assets ?? []).find(
      (a) =>
        a.is_dir !== false &&
        a.name === folderName &&
        (a.parent_uid ?? "") === parentFolderUid
    );
  }

  /**
   * Get top-level asset folders under stack root (`cs_root`).
   * Prefer `getAssetSubfolders` / `findAssetFolderByName` when the parent is known.
   */
  async getAssetFolders(): Promise<{ uid: string; name: string; parent_uid?: string }[]> {
    return this.getAssetSubfolders("cs_root");
  }

  /**
   * Multipart upload. Field names per CMA: `asset[upload]`, optional `asset[parent_uid]`, `asset[title]`.
   */
  async uploadAssetFile(opts: {
    buffer: Buffer;
    filename: string;
    contentType: string;
    title: string;
    parentFolderUid?: string;
  }): Promise<{ uid: string }> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(opts.buffer)], { type: opts.contentType });
    form.append("asset[upload]", blob, opts.filename);
    form.append("asset[title]", opts.title);
    if (opts.parentFolderUid) {
      form.append("asset[parent_uid]", opts.parentFolderUid);
    }

    const res = await fetch(`${this.base()}/assets`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} POST asset: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as { asset: { uid: string } };
    return { uid: json.asset.uid };
  }

  async updateEntry(
    contentTypeUid: string,
    entryUid: string,
    entry: { title: string; [key: string]: unknown },
    locale?: string
  ): Promise<{ uid: string; [k: string]: unknown }> {
    const q = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    const url = `${this.base()}/content_types/${encodeURIComponent(contentTypeUid)}/entries/${encodeURIComponent(entryUid)}${q}`;
    const body = JSON.stringify({ entry });
    const res = await fetch(url, { method: "PUT", headers: this.headers(), body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} PUT entry: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as { entry: { uid: string } };
    return json.entry as { uid: string };
  }

  async getEntry(
    contentTypeUid: string,
    entryUid: string,
    locale?: string
  ): Promise<{ uid: string; version?: number; [k: string]: unknown }> {
    const q = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    const url = `${this.base()}/content_types/${encodeURIComponent(contentTypeUid)}/entries/${encodeURIComponent(entryUid)}${q}`;
    const res = await fetch(url, { headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} GET entry: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as { entry: { uid: string; version?: number; [k: string]: unknown } };
    return json.entry;
  }

  /** Find entry UIDs with an exact `title` match (CMA query + client-side filter). */
  async findEntryUidsByExactTitle(
    contentTypeUid: string,
    title: string,
    locale?: string
  ): Promise<string[]> {
    const t = title.trim();
    if (!t) return [];
    const params = new URLSearchParams({
      query: JSON.stringify({ title: t }),
      limit: "10",
    });
    if (locale) params.set("locale", locale);
    const url = `${this.base()}/content_types/${encodeURIComponent(contentTypeUid)}/entries?${params}`;
    const res = await fetch(url, { headers: this.headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} GET entries by title: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as { entries?: { uid?: string; title?: string }[] };
    const uids: string[] = [];
    for (const e of json.entries ?? []) {
      if (String(e.title ?? "").trim() !== t) continue;
      const uid = e.uid?.trim();
      if (uid) uids.push(uid);
    }
    return uids;
  }

  /**
   * Publish a single entry. Uses CMA publish endpoint; environments/locales come from opts.
   * @see https://www.contentstack.com/docs/developers/apis/content-management-api/
   */
  async publishEntry(
    contentTypeUid: string,
    entryUid: string,
    opts: {
      environments: string[];
      locales: string[];
      localeQuery?: string;
      version?: number;
    }
  ): Promise<void> {
    const localeQ =
      opts.localeQuery ?? (opts.locales[0] ? `?locale=${encodeURIComponent(opts.locales[0])}` : "");
    const url = `${this.base()}/content_types/${encodeURIComponent(contentTypeUid)}/entries/${encodeURIComponent(entryUid)}/publish${localeQ}`;
    const body: Record<string, unknown> = {
      entry: {
        environments: opts.environments,
        locales: opts.locales,
      },
    };
    if (opts.version !== undefined) body.version = opts.version;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} POST publish: ${text.slice(0, 800)}`);
  }

  private branchHeaders(): Record<string, string> {
    const branch = process.env.CONTENTSTACK_BRANCH?.trim();
    if (!branch) return {};
    return { branch };
  }

  private releaseHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      "Content-Type": "application/json",
      ...this.branchHeaders(),
    };
    const releaseVersion = process.env.CONTENTSTACK_RELEASE_VERSION?.trim();
    if (releaseVersion) headers.release_version = releaseVersion;
    return headers;
  }

  async listReleases(): Promise<{ uid: string; name: string }[]> {
    const releases: { uid: string; name: string }[] = [];
    let skip = 0;
    const limit = 100;
    while (true) {
      const url = `${this.base()}/releases?limit=${limit}&skip=${skip}`;
      const res = await fetch(url, { headers: this.releaseHeaders() });
      const text = await res.text();
      if (!res.ok) throw new Error(`Contentstack ${res.status} GET releases: ${text.slice(0, 800)}`);
      const json = JSON.parse(text) as { releases?: { uid?: string; name?: string }[] };
      const items = json.releases ?? [];
      for (const r of items) {
        const uid = r.uid?.trim();
        const name = r.name?.trim();
        if (uid && name) releases.push({ uid, name });
      }
      if (items.length < limit) break;
      skip += limit;
    }
    return releases;
  }

  async findReleaseUidByName(name: string): Promise<string | undefined> {
    const target = name.trim();
    if (!target) return undefined;
    const releases = await this.listReleases();
    const match = releases.find((r) => r.name === target);
    return match?.uid;
  }

  async createRelease(name: string, description?: string): Promise<{ uid: string }> {
    const body = {
      release: {
        name: name.trim(),
        description: description?.trim() || "",
        locked: false,
        archived: false,
      },
    };
    const res = await fetch(`${this.base()}/releases`, {
      method: "POST",
      headers: this.releaseHeaders(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} POST release: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as { release?: { uid?: string } };
    const uid = json.release?.uid?.trim();
    if (!uid) throw new Error(`Contentstack create release missing uid: ${text.slice(0, 800)}`);
    return { uid };
  }

  /** Find an existing release by name or create one when `createIfMissing` is true. */
  async ensureRelease(name: string, createIfMissing = true): Promise<string> {
    const existing = await this.findReleaseUidByName(name);
    if (existing) return existing;
    if (!createIfMissing) {
      throw new Error(`Release not found: "${name}" (set CONTENTSTACK_RELEASE_CREATE=1 to create)`);
    }
    const created = await this.createRelease(name);
    return created.uid;
  }

  async listReleaseItems(
    releaseUid: string
  ): Promise<{ uid: string; locale: string; content_type_uid: string; version?: number }[]> {
    const url = `${this.base()}/releases/${encodeURIComponent(releaseUid)}/items`;
    const res = await fetch(url, { headers: this.releaseHeaders() });
    const text = await res.text();
    if (!res.ok) throw new Error(`Contentstack ${res.status} GET release items: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as {
      items?: { uid?: string; locale?: string; content_type_uid?: string; version?: number }[];
    };
    const out: { uid: string; locale: string; content_type_uid: string; version?: number }[] = [];
    for (const item of json.items ?? []) {
      const uid = item.uid?.trim();
      const loc = item.locale?.trim();
      const ct = item.content_type_uid?.trim();
      if (!uid || !loc || !ct) continue;
      out.push({
        uid,
        locale: loc,
        content_type_uid: ct,
        version: typeof item.version === "number" ? item.version : undefined,
      });
    }
    return out;
  }

  async addItemsToRelease(
    releaseUid: string,
    items: {
      uid: string;
      version: number;
      locale: string;
      content_type_uid: string;
      action: "publish" | "unpublish";
    }[]
  ): Promise<void> {
    if (items.length === 0) return;
    const url = `${this.base()}/releases/${encodeURIComponent(releaseUid)}/items`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.releaseHeaders(),
      body: JSON.stringify({ items }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} POST release items: ${text.slice(0, 800)}`);
    }
  }

  /** Pin all release items to their latest entry/asset versions before deploy. */
  async updateReleaseItemsToLatest(releaseUid: string): Promise<void> {
    const url = `${this.base()}/releases/${encodeURIComponent(releaseUid)}/update_items`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.releaseHeaders(),
      body: JSON.stringify({ items: ["$all"] }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Contentstack ${res.status} PUT release update_items: ${text.slice(0, 800)}`);
    }
  }
}
