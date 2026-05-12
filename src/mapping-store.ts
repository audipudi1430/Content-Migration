import { readFile, writeFile } from "node:fs/promises";

export type WpEntityKind =
  | "category"
  | "tag"
  | "author"
  | "asset"
  | "post"
  | "page"
  | "custom";

export type MappingRecord = {
  wpId: number;
  kind: WpEntityKind;
  /** Contentstack entry UID (posts/pages/taxonomies as entries) */
  contentstackUid?: string;
  /** Contentstack asset UID (media) */
  assetUid?: string;
  /** Optional locale if you migrate per-locale */
  locale?: string;
  migratedAt: string;
  /** WordPress slug or path for debugging */
  sourceKey?: string;
};

/** Resume state for long-running migrations (not individual WP→CS record mappings). */
export type MigrationState = {
  /**
   * Offset into the WordPress media list (`/wp/v2/media` with orderby=id&order=asc).
   * Next run continues from this position.
   */
  wpMediaListOffset?: number;
  /** UID of the Contentstack asset folder used for WordPress media (created once). */
  wpMediaAssetFolderUid?: string;
};

export type MigrationMapFile = {
  version: 1;
  updatedAt: string;
  records: Record<string, MappingRecord>;
  state?: MigrationState;
};

function keyFor(kind: WpEntityKind, wpId: number, locale?: string) {
  return locale ? `${kind}:${wpId}:${locale}` : `${kind}:${wpId}`;
}

export class MappingStore {
  private data: MigrationMapFile;

  constructor(private readonly path: string, initial?: MigrationMapFile) {
    this.data =
      initial ??
      ({
        version: 1,
        updatedAt: new Date().toISOString(),
        records: {},
        state: {},
      } satisfies MigrationMapFile);
  }

  static async load(filePath: string): Promise<MappingStore> {
    console.error('Loading map from:', filePath);
    try {
      const raw = await readFile(filePath, "utf8");
      console.error('File exists, reading...');
      const parsed = JSON.parse(raw) as MigrationMapFile;
      console.error('Parsed data:', JSON.stringify(parsed, null, 2));
      if (parsed.version !== 1 || !parsed.records) {
        throw new Error("Invalid migration map file");
      }
      if (!parsed.state) parsed.state = {};
      return new MappingStore(filePath, parsed);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        console.error('File does not exist, creating default');
        return new MappingStore(filePath);
      }
      console.error('Error loading map:', (e as Error).message);
      throw e;
    }
  }

  async save(): Promise<void> {
    console.error('Saving map to:', this.path);
    console.error('Data to save:', JSON.stringify(this.data, null, 2));
    this.data.updatedAt = new Date().toISOString();
    await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf8");
    console.error('Saved map');
  }

  get(kind: WpEntityKind, wpId: number, locale?: string): MappingRecord | undefined {
    return this.data.records[keyFor(kind, wpId, locale)];
  }

  set(record: MappingRecord): void {
    const k = keyFor(record.kind, record.wpId, record.locale);
    this.data.records[k] = record;
  }

  has(kind: WpEntityKind, wpId: number, locale?: string): boolean {
    return keyFor(kind, wpId, locale) in this.data.records;
  }

  getMediaListOffset(): number {
    return this.data.state?.wpMediaListOffset ?? 0;
  }

  setMediaListOffset(n: number): void {
    if (!this.data.state) this.data.state = {};
    this.data.state.wpMediaListOffset = n;
  }

  getWpMediaAssetFolderUid(): string | undefined {
    const uid = this.data.state?.wpMediaAssetFolderUid;
    console.error('getWpMediaAssetFolderUid:', uid);
    return uid;
  }

  setWpMediaAssetFolderUid(uid: string): void {
    if (!this.data.state) this.data.state = {};
    this.data.state.wpMediaAssetFolderUid = uid;
  }
}

/** Resolve a WordPress taxonomy or entry reference to a Contentstack UID after dependencies run */
export function requireMappedUid(
  store: MappingStore,
  kind: WpEntityKind,
  wpId: number,
  locale?: string
): string {
  const r = store.get(kind, wpId, locale);
  const uid = r?.contentstackUid ?? r?.assetUid;
  if (!uid) {
    throw new Error(`No mapping for ${kind} wpId=${wpId}${locale ? ` locale=${locale}` : ""}`);
  }
  return uid;
}
