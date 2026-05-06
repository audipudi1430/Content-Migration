import type { WpEntityKind } from "../mapping-store.js";

export type WpPaged<T> = { data: T[]; totalPages: number };

/**
 * Thin WordPress REST client. Extend per entity (categories, media, posts, pages).
 * Uses Basic auth if WP_USER + WP_APPLICATION_PASSWORD are set (Application Passwords).
 */
export class WordPressClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authHeader?: string
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.authHeader) h.Authorization = this.authHeader;
    return h;
  }

  /**
   * One page of a collection, with WordPress total headers.
   * @param path e.g. `wp-json/wp/v2/media`
   */
  async getCollectionPage<T>(
    path: string,
    searchParams: Record<string, string>
  ): Promise<{ items: T[]; total: number; totalPages: number }> {
    const u = new URL(path.replace(/^\//, ""), this.baseUrl + "/");
    for (const [k, v] of Object.entries(searchParams)) u.searchParams.set(k, v);
    const res = await fetch(u, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WP ${res.status} ${u}: ${body.slice(0, 500)}`);
    }
    const items = (await res.json()) as T[];
    const total = Number(res.headers.get("X-WP-Total") ?? String(items.length));
    const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
    return { items, total, totalPages };
  }

  async getJson<T>(path: string, searchParams?: Record<string, string>): Promise<T> {
    const u = new URL(path.replace(/^\//, ""), this.baseUrl + "/");
    if (searchParams) {
      for (const [k, v] of Object.entries(searchParams)) u.searchParams.set(k, v);
    }
    const res = await fetch(u, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WP ${res.status} ${u}: ${body.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }

  /** Fetch all pages for a collection endpoint (uses X-WP-TotalPages). */
  async collectAll<T>(path: string, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const u = new URL(path.replace(/^\//, ""), this.baseUrl + "/");
      u.searchParams.set("per_page", String(perPage));
      u.searchParams.set("page", String(page));
      const res = await fetch(u, { headers: this.headers() });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`WP ${res.status} ${u}: ${body.slice(0, 500)}`);
      }
      const data = (await res.json()) as T[];
      totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
      out.push(...data);
      page += 1;
    }
    return out;
  }

  /** Download bytes (e.g. media `source_url`). Sends WP auth when configured. */
  async fetchBinary(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fetch ${res.status} ${url}: ${body.slice(0, 300)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    return { buffer: Buffer.from(arrayBuffer), contentType };
  }
}

export function basicAuthHeader(user: string, appPassword: string): string {
  const token = Buffer.from(`${user}:${appPassword}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/** Example: map WP REST type to our kind */
export function wpPostTypeToKind(postType: string): WpEntityKind {
  if (postType === "post") return "post";
  if (postType === "page") return "page";
  return "custom";
}
