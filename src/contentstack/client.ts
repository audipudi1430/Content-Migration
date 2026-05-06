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
    const body: { asset: { name: string; parent_uid?: string } } = { asset: { name } };
    if (parentUid) body.asset.parent_uid = parentUid;

    const tryBodies = [
      body,
      { asset_folder: { name, ...(parentUid ? { parent_uid: parentUid } : {}) } },
    ];

    let lastErr = "";
    for (const b of tryBodies) {
      const res = await fetch(`${this.base()}/assets/folders`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(b),
      });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text) as { asset?: { uid: string }; asset_folder?: { uid: string } };
        const uid = json.asset?.uid ?? json.asset_folder?.uid;
        if (uid) return { uid };
        lastErr = text.slice(0, 400);
        continue;
      }
      lastErr = `${res.status}: ${text.slice(0, 400)}`;
    }
    throw new Error(`Contentstack create folder failed: ${lastErr}`);
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
}
