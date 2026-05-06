import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

function collectNumericValues(node: unknown, out: number[]): void {
  if (typeof node === "number" && Number.isFinite(node) && node > 0) {
    out.push(node);
    return;
  }
  if (typeof node === "string") {
    const n = Number(node.trim());
    if (Number.isFinite(n) && n > 0) out.push(n);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectNumericValues(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectNumericValues(v, out);
    }
  }
}

export async function readIdsFromXml(path: string): Promise<number[]> {
  const raw = await readFile(path, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  });
  const parsed = parser.parse(raw);
  const ids: number[] = [];
  collectNumericValues(parsed, ids);
  return [...new Set(ids)];
}
