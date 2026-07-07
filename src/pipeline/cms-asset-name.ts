import type { ContentstackManagementClient } from "../contentstack/client.js";

export function micrositeLabel(microsite?: string): string {
  return (microsite ?? process.env.MIGRATION_MICROSITE ?? "").trim();
}

export function usesMicrositeCmsAssetName(microsite?: string): boolean {
  return Boolean(micrositeLabel(microsite));
}

/** True when Contentstack locale is English (`en`, `en-us`, `en-gb`, …). */
export function isEnglishContentstackLocale(locale?: string): boolean {
  const loc = (locale ?? process.env.CONTENTSTACK_LOCALE ?? "en-us").trim().toLowerCase();
  if (!loc) return true;
  return loc === "en" || loc.startsWith("en-");
}

function cmsAssetNameSuffix(microsite: string): string {
  return ` - ${microsite}`;
}

function titleAlreadyHasMicrositeSuffix(title: string, microsite: string): boolean {
  const spaced = cmsAssetNameSuffix(microsite).toLowerCase();
  const compact = `-${microsite}`.toLowerCase();
  const lower = title.trim().toLowerCase();
  return lower.endsWith(spaced) || lower.endsWith(compact);
}

/**
 * CMS Asset Name (`title` / unique entry title) for microsite migrations.
 * When `MIGRATION_MICROSITE` is set: `{title} - {microsite}` (e.g. `News - EMEA`).
 */
export function resolveCmsAssetName(
  title: string,
  opts?: { locale?: string; microsite?: string }
): string {
  void opts?.locale;
  const base = title.trim() || "Untitled";
  const microsite = micrositeLabel(opts?.microsite);
  if (!microsite || titleAlreadyHasMicrositeSuffix(base, microsite)) {
    return base;
  }
  return `${base}${cmsAssetNameSuffix(microsite)}`;
}

/**
 * Microsite runs create separate entries — resolve by suffixed CMS Asset Name, not the default map row.
 */
export async function resolveExistingUidForCmsAssetName(opts: {
  cs: ContentstackManagementClient;
  contentTypeUid: string;
  cmsAssetName: string;
  locale?: string;
  microsite?: string;
  updateExisting: boolean;
  fallbackUid?: string;
}): Promise<string | undefined> {
  const microsite = micrositeLabel(opts.microsite);
  if (!microsite) {
    return opts.fallbackUid?.trim() || undefined;
  }
  if (!opts.updateExisting) {
    return undefined;
  }
  const matches = await opts.cs.findEntryUidsByExactTitle(
    opts.contentTypeUid,
    opts.cmsAssetName.trim(),
    opts.locale
  );
  return matches[0];
}

export function mappingSourceKeyWithMicrosite(
  sourceKey: string,
  microsite?: string
): string {
  const base = sourceKey.trim();
  const ms = micrositeLabel(microsite);
  if (!base || !ms) return base;
  return `${base}|${ms}`;
}
